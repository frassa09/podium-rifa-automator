import express from 'express'
import { createServer, type Server } from 'node:http'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { abrirBanco, type Banco } from '../data/abrirBanco.ts'
import { Automator } from '../engine/automator.ts'
import { PodiumSession } from '../podium/session.ts'
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
}

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

  // Não libera lock válido de outra instância (deploy sobrepondo); só os expirados.
  await banco.reconciliarExpirados()

  const app = express()
  app.use(express.json({ limit: '50mb' }))
  app.use(express.static(WEB_DIR))
  app.use((req, res, next) => {
    res.setHeader('X-Powered-By', 'rifa-automator')
    next()
  })

  if (pin) {
    app.use((req, res, next) => {
      if (req.path === '/api/health') {
        next()
        return
      }
      const recebido = req.header('X-PIN')
      if (!recebido || !pinValido(recebido, pin)) {
        res.status(401).json({ ok: false, erro: 'PIN inválido' })
        return
      }
      next()
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
