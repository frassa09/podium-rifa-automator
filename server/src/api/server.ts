import express from 'express'
import { createServer, type Server } from 'node:http'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { abrirBanco, type Banco } from '../data/abrirBanco.ts'
import { Automator } from '../engine/automator.ts'
import { PodiumSession, contarRifasDoCpf } from '../podium/session.ts'
import { pinValido } from '../utils/pin.ts'
import { parseLinhas, validarPessoa, type LinhaParseada } from '../utils/tableParser.ts'
import { apenasDigitos } from '../utils/cpf.ts'
import type { Config, Pessoa, StatusJob } from '../types.ts'
import { LEASE_MS } from '../data/banco.ts'
import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WEB_DIR = join(__dirname, '..', '..', '..', 'web', 'src')

interface Runner {
  parar: () => void
  terminou: Promise<void>
}

// Para de enviar quando faltar menos que isto para o lease vencer sem renovação.
const MARGEM_LEASE_MS = 20_000

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = Buffer.from(b64, 'base64')
  return bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer
}

function lerEnvConfig(): Config | null {
  const cpf = process.env.RIFA_CPF
  const senha = process.env.RIFA_SENHA
  if (!cpf || !senha) return null
  return { cpf, senha, turma: process.env.RIFA_TURMA ?? '' }
}

function lerMaxQuantidade(): number {
  const v = Number(process.env.MAX_QUANTIDADE)
  return Number.isInteger(v) && v > 0 ? v : 100
}

export interface StartOpts {
  port?: number
  db?: Banco
  pin?: string
  envConfig?: Config | null
  maxQuantidade?: number
  login?: (cpf: string, senha: string) => Promise<PodiumSession>
  // Identidade desta instância no lock de execução (padrão: host:pid:aleatório).
  instancia?: string
  renovacaoMs?: number
  // Padrão: DATABASE_URL presente ou NODE_ENV=production.
  producao?: boolean
  atrasoPinMs?: number
}

export const PIN_MIN_PRODUCAO = 12
const PIN_MAX_FALHAS = 5
const PIN_BLOQUEIO_MS = 15 * 60_000

export async function startServer(opts: StartOpts = {}): Promise<{
  app: express.Express
  server: Server
  banco: Banco
  pararTodos: () => void
  aguardarRunners: (limiteMs: number) => Promise<boolean>
}> {
  const banco = opts.db ?? (await abrirBanco())
  const envConfig = opts.envConfig !== undefined ? opts.envConfig : lerEnvConfig()
  const maxQuantidade = opts.maxQuantidade ?? lerMaxQuantidade()
  const pin = opts.pin ?? process.env.RIFA_PIN ?? ''
  const login = opts.login ?? PodiumSession.login
  const instancia = opts.instancia ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`
  const renovacaoMs = opts.renovacaoMs ?? 15_000
  let encerrando = false
  const producao = opts.producao ?? (Boolean(process.env.DATABASE_URL) || process.env.NODE_ENV === 'production')
  const atrasoPinMs = opts.atrasoPinMs ?? 1000

  // Em produção (URL pública) nada sobe aberto nem com senha da Podium gravada no banco.
  if (producao) {
    if (pin.length < PIN_MIN_PRODUCAO) {
      throw new Error(`Produção exige RIFA_PIN com pelo menos ${PIN_MIN_PRODUCAO} caracteres`)
    }
    if (!envConfig) {
      throw new Error('Produção exige RIFA_CPF e RIFA_SENHA nas variáveis de ambiente (senha não vai para o banco)')
    }
  }

  // Não libera lock válido de outra instância (deploy sobrepondo); só os expirados.
  await banco.reconciliarExpirados()

  const app = express()
  // Atrás do proxy do Render, req.ip vem de X-Forwarded-For (1 salto). Na LAN, não confiar no cabeçalho.
  if (producao) app.set('trust proxy', 1)
  app.use(express.json({ limit: '5mb' }))
  app.use(express.static(WEB_DIR))
  app.use((req, res, next) => {
    res.setHeader('X-Powered-By', 'rifa-automator')
    next()
  })

  if (pin) {
    // Após PIN_MAX_FALHAS erros do mesmo IP, bloqueia por PIN_BLOQUEIO_MS (memória basta: instância única).
    // Pedido sem PIN (tela recém-aberta) não conta como tentativa.
    const tentativas = new Map<string, { falhas: number; bloqueadoAte: number }>()
    app.use(async (req, res, next) => {
      if (req.path === '/api/health' || !req.path.startsWith('/api/')) {
        next()
        return
      }
      const ip = req.ip ?? 'desconhecido'
      const agora = Date.now()
      const reg = tentativas.get(ip)
      if (reg && reg.bloqueadoAte > agora) {
        const min = Math.ceil((reg.bloqueadoAte - agora) / 60_000)
        res.status(429).json({ ok: false, erro: `Muitas tentativas de PIN. Tente de novo em ${min} min.` })
        return
      }
      const recebido = req.header('X-PIN')
      if (recebido && pinValido(recebido, pin)) {
        tentativas.delete(ip)
        next()
        return
      }
      if (recebido) {
        await new Promise(r => setTimeout(r, atrasoPinMs))
        const falhas = (reg?.falhas ?? 0) + 1
        tentativas.set(ip, falhas >= PIN_MAX_FALHAS ? { falhas: 0, bloqueadoAte: agora + PIN_BLOQUEIO_MS } : { falhas, bloqueadoAte: 0 })
        if (tentativas.size > 10_000) {
          for (const [k, v] of tentativas) if (v.bloqueadoAte < agora && v.falhas === 0) tentativas.delete(k)
        }
      }
      res.status(401).json({ ok: false, erro: 'PIN inválido' })
    })
  } else {
    console.log('[rifa] Aviso: RIFA_PIN ausente — autenticação desligada (modo LAN).')
  }

  const runners = new Map<number, Runner>()

  async function configAtual(): Promise<Config | null> {
    return envConfig ?? (await banco.lerConfig())
  }

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true })
  })

  app.get('/api/config', async (_req, res) => {
    const c = await configAtual()
    if (!c) {
      res.json({ configurado: false, maxQuantidade })
      return
    }
    res.json({
      configurado: true,
      cpf: c.cpf,
      turma: c.turma,
      viaAmbiente: envConfig !== null,
      maxQuantidade,
    })
  })

  app.post('/api/config', async (req, res) => {
    if (envConfig) {
      res.status(409).json({ ok: false, erro: 'Credenciais definidas via ambiente (RIFA_CPF/RIFA_SENHA) — altere as variáveis do serviço.' })
      return
    }
    const { cpf, senha, turma } = req.body as Partial<Config>
    if (!cpf || !senha) {
      res.status(400).json({ ok: false, erro: 'cpf e senha obrigatórios' })
      return
    }
    const atual = (await banco.lerConfig()) ?? ({ cpf: '', senha: '', turma: '' } as Config)
    await banco.gravarConfig({ cpf, senha, turma: turma ?? atual.turma })
    res.json({ configurado: true })
  })

  app.post('/api/test-login', async (req, res) => {
    const atual = await configAtual()
    const cpf = (req.body?.cpf as string) ?? atual?.cpf
    const senha = (req.body?.senha as string) ?? atual?.senha
    if (!cpf || !senha) {
      res.status(400).json({ ok: false, erro: 'Configure CPF e senha primeiro' })
      return
    }
    try {
      const s = await login(cpf, senha)
      res.json({ ok: true, turma: s.turma })
    } catch (e) {
      res.json({ ok: false, erro: (e as Error).message })
    }
  })

  app.post('/api/jobs', async (req, res) => {
    try {
      const { arquivo, texto, nomeArquivo, pessoas, semCriar } = req.body as {
        arquivo?: string
        texto?: string
        nomeArquivo?: string
        pessoas?: Pessoa[]
        semCriar?: boolean
      }
      let parsed: { ok: LinhaParseada[]; invalidas: LinhaParseada[] }
      if (Array.isArray(pessoas)) {
        const norm: Pessoa[] = pessoas.map(p => ({
          nome: (p?.nome ?? '').trim(),
          cpf: apenasDigitos(String(p?.cpf ?? '')),
          telefone: apenasDigitos(String(p?.telefone ?? '')),
          email: (p?.email ?? '').trim(),
          qtd: Math.floor(Number(p?.qtd)),
        }))
        const ok: LinhaParseada[] = []
        const invalidas: LinhaParseada[] = []
        for (const pessoa of norm) {
          const erros = validarPessoa(pessoa)
          ;(erros.length ? invalidas : ok).push({ pessoa, erros })
        }
        parsed = { ok, invalidas }
      } else {
        const buf = arquivo ? base64ToArrayBuffer(arquivo) : undefined
        parsed = await parseLinhas({ arquivo: buf, texto, nomeArquivo })
      }
      const acimaTeto = parsed.ok.filter(l => l.pessoa.qtd > maxQuantidade)
      const invalidas = [...parsed.invalidas, ...acimaTeto.map(l => ({ pessoa: l.pessoa, erros: [`Qtd máxima por pessoa é ${maxQuantidade}`] }))]
      if (invalidas.length) {
        res.status(422).json({ ok: false, invalidas })
        return
      }
      if (parsed.ok.length === 0) {
        res.status(422).json({ ok: false, invalidas: [], erro: 'Nenhuma linha válida' })
        return
      }
      if (semCriar === true) {
        const totalRifas = parsed.ok.reduce((s, l) => s + l.pessoa.qtd, 0)
        res.json({ ok: true, preview: true, totalRifas, linhas: parsed.ok.length, maxQuantidade })
        return
      }
      const jobId = await banco.criarJob(parsed.ok.map(l => l.pessoa))
      await banco.registrarLog(`Job #${jobId} criado com ${parsed.ok.length} rifa(s)`, 'info', jobId)
      res.json({ ok: true, jobId })
    } catch (e) {
      res.status(400).json({ ok: false, erro: (e as Error).message })
    }
  })

  app.get('/api/jobs', async (_req, res) => {
    res.json(await banco.listarJobs())
  })

  app.get('/api/jobs/:id', async (req, res) => {
    const id = Number(req.params.id)
    const job = (await banco.listarJobs()).find(j => j.id === id)
    if (!job) {
      res.status(404).json({ ok: false, erro: 'Job não encontrado' })
      return
    }
    res.json({
      job,
      linhas: await banco.linhasDoJob(id),
      resumo: await banco.resumoJob(id),
      logs: await banco.logs(id, 100),
    })
  })

  // O runner só envia enquanto tem lock válido. Para antes do próximo POST se: cancelaram
  // (aqui ou em outra instância), a renovação falhou, ou o lease está perto de vencer.
  async function rodarJob(jobId: number): Promise<void> {
    let pararLocal = false
    let perdeuLock = false
    let leaseAte = Date.now() + LEASE_MS
    let fim: () => void = () => {}
    const terminou = new Promise<void>(r => { fim = r })
    runners.set(jobId, { parar: () => { pararLocal = true }, terminou })
    const deveParar = () => pararLocal || perdeuLock || Date.now() > leaseAte - MARGEM_LEASE_MS
    const log = (msg: string, nivel: 'info' | 'warn' | 'error' = 'info') => {
      banco.registrarLog(msg, nivel, jobId).catch(e => console.error('[rifa] falha ao gravar log:', e))
    }

    const renovar = async () => {
      const antes = Date.now()
      try {
        const r = await banco.renovarLock(jobId, instancia, antes)
        if (!r.ok) {
          perdeuLock = true
          log('Lock de execução perdido; parando antes do próximo envio', 'error')
          return
        }
        leaseAte = antes + LEASE_MS
        if (r.cancelar) pararLocal = true
      } catch (e) {
        log(`Falha ao renovar o lock (${(e as Error).message}); o job para se não renovar a tempo`, 'warn')
      }
    }
    const batimento = setInterval(() => void renovar(), renovacaoMs)
    batimento.unref()

    let statusFinal: StatusJob = 'pendente'
    try {
      const config = await configAtual()
      if (!config) throw new Error('login não configurado')
      let sessao = await login(config.cpf, config.senha)
      const automator = new Automator({
        getSessao: async () => sessao,
        // Um POST por chamada; nunca repetir aqui. Se a sessão caiu, renova para a próxima medição.
        submeterLinha: async (s, p) => {
          try {
            return await (s as PodiumSession).submeterRifa(p)
          } catch (e) {
            const okSessao = await (s as PodiumSession).checarSessao().catch(() => false)
            if (!okSessao) sessao = await login(config.cpf, config.senha)
            throw e
          }
        },
        // Leitura é idempotente: pode renovar a sessão e ler de novo uma vez.
        contarRifasDoCpf: async (s, cpf) => {
          try {
            return await (s as PodiumSession).contarRifasDoCpf(cpf)
          } catch {
            sessao = await login(config.cpf, config.senha)
            return sessao.contarRifasDoCpf(cpf)
          }
        },
        salvarLinha: l => banco.atualizarLinha(l),
        log,
        deveParar,
      })
      await automator.start(await banco.linhasDoJob(jobId))
      statusFinal = deveParar() ? 'pendente' : 'concluido'
      if (pararLocal) log('Job parado a pedido', 'warn')
    } catch (e) {
      await banco.registrarLog(`Erro ao rodar job #${jobId}: ${(e as Error).message}`, 'error', jobId).catch(() => undefined)
    } finally {
      clearInterval(batimento)
      // liberarLock só age se o lock ainda é desta instância.
      await banco.liberarLock(jobId, instancia, statusFinal).catch(e => console.error('[rifa] falha ao liberar lock:', e))
      runners.delete(jobId)
      fim()
    }
  }

  app.post('/api/jobs/:id/iniciar', async (req, res) => {
    const id = Number(req.params.id)
    const config = await configAtual()
    if (!config) {
      res.status(400).json({ ok: false, erro: 'Configure o login primeiro' })
      return
    }
    if (encerrando) {
      res.status(503).json({ ok: false, erro: 'Servidor reiniciando; tente de novo em instantes' })
      return
    }
    if (runners.has(id)) {
      res.status(409).json({ ok: false, erro: 'Job já está rodando' })
      return
    }
    const existe = (await banco.listarJobs()).some(j => j.id === id)
    if (!existe) {
      res.status(404).json({ ok: false, erro: 'Job não encontrado' })
      return
    }
    const assumiu = await banco.tentarIniciarJob(id, instancia)
    if (!assumiu) {
      res.status(409).json({ ok: false, erro: 'Já existe um job rodando (nesta ou em outra instância)' })
      return
    }
    await banco.registrarLog(`Iniciando job #${id}`, 'info', id)
    void rodarJob(id)
    res.json({ ok: true })
  })

  // Só sinaliza. O status muda quando o runner realmente sai (nunca no meio de um POST).
  app.post('/api/jobs/:id/cancelar', async (req, res) => {
    const id = Number(req.params.id)
    runners.get(id)?.parar()
    const sinalizado = await banco.cancelarJob(id)
    await banco.registrarLog('Cancelamento solicitado; o job para antes do próximo envio', 'warn', id)
    res.json({ ok: true, sinalizado })
  })

  app.post('/api/jobs/:id/reprocessar-erros', async (req, res) => {
    const id = Number(req.params.id)
    await banco.reprocessarErros(id)
    await banco.registrarLog('Reprocessando erros', 'info', id)
    res.json({ ok: true })
  })

  // §2.3 — humano no circuito. Nada aqui roda com job ativo: um segundo login na mesma
  // conta poderia derrubar a sessão do runner no meio de um envio.
  async function exigirSemJobAtivo(res: express.Response): Promise<boolean> {
    if (runners.size > 0 || (await banco.algumLockValido())) {
      res.status(409).json({ ok: false, erro: 'Há um job rodando; confira depois que ele terminar' })
      return false
    }
    return true
  }

  app.get('/api/jobs/:id/conferencia', async (req, res) => {
    const id = Number(req.params.id)
    const config = await configAtual()
    if (!config) {
      res.status(400).json({ ok: false, erro: 'Configure o login primeiro' })
      return
    }
    const linhas = await banco.linhasDoJob(id)
    if (!linhas.length) {
      res.status(404).json({ ok: false, erro: 'Job não encontrado' })
      return
    }
    if (!(await exigirSemJobAtivo(res))) return
    try {
      const rifas = await (await login(config.cpf, config.senha)).lerRifas()
      res.json({
        ok: true,
        linhas: linhas.map(l => {
          const site = contarRifasDoCpf(rifas, l.cpf)
          return {
            id: l.id, seq: l.seq, nome: l.nome, cpf: l.cpf, status: l.status, qtd: l.qtd,
            base_cpf: l.base_cpf, tentativas: l.tentativas, confirmadas: l.confirmadas,
            // Rifas do CPF no site hoje e quantas surgiram desde a base desta linha.
            site, desdeBase: l.base_cpf === null ? null : site - l.base_cpf,
          }
        }),
      })
    } catch (e) {
      res.status(502).json({ ok: false, erro: `Não foi possível ler o site: ${(e as Error).message}` })
    }
  })

  app.post('/api/linhas/:id/resolver', async (req, res) => {
    const acao = (req.body as { acao?: string } | undefined)?.acao
    if (acao !== 'marcar_ok' && acao !== 'liberar_reenvio') {
      res.status(400).json({ ok: false, erro: "acao deve ser 'marcar_ok' ou 'liberar_reenvio'" })
      return
    }
    const l = await banco.linhaPorId(Number(req.params.id))
    if (!l) {
      res.status(404).json({ ok: false, erro: 'Linha não encontrada' })
      return
    }
    if (l.status !== 'incerto') {
      res.status(409).json({ ok: false, erro: 'Só linhas incertas podem ser resolvidas' })
      return
    }
    if (!(await exigirSemJobAtivo(res))) return

    if (acao === 'marcar_ok') {
      await banco.atualizarLinha({ ...l, status: 'ok', erro: null })
      await banco.registrarLog(`Linha #${l.id} marcada ok manualmente após conferência`, 'warn', l.job_id)
      res.json({ ok: true })
      return
    }

    // liberar_reenvio: só se a contagem atual do site PROVAR que faltam rifas.
    const config = await configAtual()
    if (!config) {
      res.status(400).json({ ok: false, erro: 'Configure o login primeiro' })
      return
    }
    if (l.base_cpf === null) {
      res.status(409).json({ ok: false, erro: 'Linha sem contagem base; não dá para provar quantas faltam. Confira no site e marque ok se for o caso.' })
      return
    }
    let atual: number
    try {
      atual = await (await login(config.cpf, config.senha)).contarRifasDoCpf(l.cpf)
    } catch (e) {
      res.status(502).json({ ok: false, erro: `Não foi possível ler o site: ${(e as Error).message}` })
      return
    }
    const confirmadas = atual - l.base_cpf
    if (confirmadas < 0) {
      res.status(409).json({ ok: false, erro: `O site mostra ${atual} rifa(s) do CPF, menos que a base ${l.base_cpf}. Confira manualmente.` })
      return
    }
    if (confirmadas >= l.qtd) {
      res.status(409).json({ ok: false, erro: `O site já mostra ${confirmadas} rifa(s) desde a base (pedido: ${l.qtd}). Marque ok em vez de reenviar.` })
      return
    }
    await banco.atualizarLinha({ ...l, status: 'pendente', erro: null, tentativas: confirmadas, confirmadas, enviadas: confirmadas })
    await banco.registrarLog(`Linha #${l.id} liberada para reenvio: ${confirmadas} de ${l.qtd} confirmada(s) no site`, 'warn', l.job_id)
    res.json({ ok: true, confirmadas, faltam: l.qtd - confirmadas })
  })

  const server = createServer(app)
  await new Promise<void>(r => server.listen(opts.port ?? 3000, r))

  // Desligamento (SIGTERM do Render, unhandledRejection): nenhum POST novo depois disso.
  const pararTodos = () => {
    encerrando = true
    for (const r of runners.values()) r.parar()
  }
  const aguardarRunners = async (limiteMs: number): Promise<boolean> => {
    const todos = Promise.all([...runners.values()].map(r => r.terminou)).then(() => true)
    const limite = new Promise<boolean>(r => setTimeout(() => r(false), limiteMs).unref())
    return Promise.race([todos, limite])
  }
  return { app, server, banco, pararTodos, aguardarRunners }
}
