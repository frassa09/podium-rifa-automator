import express from 'express'
import { createServer, type Server } from 'node:http'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { abrirBanco, type Banco } from '../data/abrirBanco.ts'
import { Automator } from '../engine/automator.ts'
import { PodiumSession } from '../podium/session.ts'
import { pinValido } from '../utils/pin.ts'
import { criarLimitador, type Limitador } from '../utils/limitador.ts'
import { parseLinhas, validarPessoa, type LinhaParseada } from '../utils/tableParser.ts'
import { apenasDigitos } from '../utils/cpf.ts'
import type { Config, Pessoa } from '../types.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WEB_DIR = join(__dirname, '..', '..', '..', 'web', 'src')

// Express 4 não captura rejeição de handler async: sem isto, uma queda do banco
// derrubaria o processo inteiro.
function rota(fn: (req: express.Request, res: express.Response) => Promise<void>): express.RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next)
  }
}

function falhaGravacao(e: unknown): void {
  console.error('[rifa] Falha ao gravar no banco:', (e as Error).message)
}

interface Runner {
  parar: () => void
}

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
  // Atrás do proxy HTTPS do Render: IP real do cliente vem de X-Forwarded-For.
  trustProxy?: boolean
  limitadorPin?: Limitador
}

// Frontend não usa script/estilo inline nem recursos externos: CSP pode ser estrita.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

export async function startServer(opts: StartOpts = {}): Promise<{
  app: express.Express
  server: Server
  banco: Banco
}> {
  const banco = opts.db ?? (await abrirBanco())
  const envConfig = opts.envConfig !== undefined ? opts.envConfig : lerEnvConfig()
  const maxQuantidade = opts.maxQuantidade ?? lerMaxQuantidade()
  const pin = opts.pin ?? process.env.RIFA_PIN ?? ''
  const login = opts.login ?? PodiumSession.login

  // Após crash/restart/redeploy, nenhum job pode ficar eternamente 'rodando'.
  // Retomada re-mede o site e cria apenas o que falta.
  await banco.reconciliarBoot()

  const trustProxy = opts.trustProxy ?? process.env.RENDER === 'true'
  const limitador = opts.limitadorPin ?? criarLimitador()

  const app = express()
  app.disable('x-powered-by')
  if (trustProxy) app.set('trust proxy', 1)

  app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', CSP)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    if (trustProxy) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store')
    next()
  })
  app.use(express.static(WEB_DIR))

  // PIN é checado antes de ler o corpo: sem PIN, nenhum upload grande é processado.
  if (pin) {
    app.use((req, res, next) => {
      if (req.path === '/api/health') {
        next()
        return
      }
      const ip = req.ip ?? 'desconhecido'
      const restante = limitador.bloqueado(ip)
      if (restante > 0) {
        res.setHeader('Retry-After', String(Math.ceil(restante / 1000)))
        res.status(429).json({ ok: false, erro: `Muitas tentativas de PIN. Tente de novo em ${Math.ceil(restante / 60_000)} min.` })
        return
      }
      const recebido = req.header('X-PIN')
      if (!recebido || !pinValido(recebido, pin)) {
        // Requisição sem PIN (ex.: primeira carga) não conta como tentativa.
        if (recebido) limitador.falhou(ip)
        res.status(401).json({ ok: false, erro: 'PIN inválido' })
        return
      }
      limitador.acertou(ip)
      next()
    })
  } else {
    console.log('[rifa] Aviso: RIFA_PIN ausente — autenticação desligada (modo LAN).')
  }

  app.use(express.json({ limit: '15mb' }))

  const runners = new Map<number, Runner>()

  async function configAtual(): Promise<Config | null> {
    return envConfig ?? (await banco.lerConfig())
  }

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true })
  })

  app.get('/api/config', rota(async (_req, res) => {
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
  }))

  app.post('/api/config', rota(async (req, res) => {
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
  }))

  app.post('/api/test-login', rota(async (req, res) => {
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
  }))

  app.post('/api/jobs', rota(async (req, res) => {
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
  }))

  app.get('/api/jobs', rota(async (_req, res) => {
    res.json(await banco.listarJobs())
  }))

  app.get('/api/jobs/:id', rota(async (req, res) => {
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
  }))

  async function rodarJob(jobId: number): Promise<void> {
    const config = await configAtual()
    if (!config) return
    let sessao: PodiumSession | null = null
    let deveParar = false
    const parar = () => {
      deveParar = true
    }
    runners.set(jobId, { parar })

    try {
      sessao = await login(config.cpf, config.senha)
      const automator = new Automator({
        getSessao: async () => sessao,
        submeterLinha: async (s, p) => {
          try {
            await (s as PodiumSession).submeterRifa(p)
          } catch {
            const okSessao = await (s as PodiumSession).checarSessao()
            if (!okSessao) sessao = await login(config.cpf, config.senha)
            throw new Error('sessão renovada, tentando de novo')
          }
        },
        lerMaiorNumero: async s => (s as PodiumSession).lerMaiorNumero(),
        log: (msg, nivel) => {
          banco.registrarLog(msg, nivel ?? 'info', jobId).catch(falhaGravacao)
        },
        deveParar: () => deveParar,
        onProgress: l => {
          banco.atualizarLinha(l).catch(falhaGravacao)
        },
      })
      await automator.start(await banco.linhasDoJob(jobId), l => {
        banco.atualizarLinha(l).catch(falhaGravacao)
      })
      await banco.atualizarStatusJob(jobId, deveParar ? 'pendente' : 'concluido')
    } catch (e) {
      // Se o banco também falhar aqui, o job fica 'rodando' até o próximo boot (reconciliado).
      await banco.registrarLog(`Erro ao rodar job #${jobId}: ${(e as Error).message}`, 'error', jobId).catch(falhaGravacao)
      await banco.atualizarStatusJob(jobId, 'pendente').catch(falhaGravacao)
    } finally {
      runners.delete(jobId)
    }
  }

  app.post('/api/jobs/:id/iniciar', rota(async (req, res) => {
    const id = Number(req.params.id)
    const config = await configAtual()
    if (!config) {
      res.status(400).json({ ok: false, erro: 'Configure o login primeiro' })
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
    const assumiu = await banco.tentarIniciarJob(id)
    if (!assumiu) {
      res.status(409).json({ ok: false, erro: 'Já existe um job rodando' })
      return
    }
    await banco.registrarLog(`Iniciando job #${id}`, 'info', id)
    rodarJob(id).catch(falhaGravacao)
    res.json({ ok: true })
  }))

  app.post('/api/jobs/:id/cancelar', rota(async (req, res) => {
    const id = Number(req.params.id)
    runners.get(id)?.parar()
    await banco.cancelarJob(id)
    await banco.registrarLog('Cancelamento solicitado', 'warn', id)
    res.json({ ok: true })
  }))

  app.post('/api/jobs/:id/reprocessar-erros', rota(async (req, res) => {
    const id = Number(req.params.id)
    await banco.reprocessarErros(id)
    await banco.registrarLog('Reprocessando erros', 'info', id)
    res.json({ ok: true })
  }))

  // Express só reconhece handler de erro com 4 parâmetros, mesmo que `next` não seja usado.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const e = err as { status?: number; type?: string; message?: string }
    if (e.type === 'entity.too.large') {
      res.status(413).json({ ok: false, erro: 'Arquivo grande demais (máx. ~10 MB).' })
      return
    }
    console.error('[rifa] Erro na API:', e.message ?? err)
    res.status(e.status && e.status < 500 ? e.status : 500).json({ ok: false, erro: 'Erro interno. Tente de novo em instantes.' })
  })

  const server = createServer(app)
  await new Promise<void>(r => server.listen(opts.port ?? 3000, r))
  return { app, server, banco }
}