import express from 'express'
import { createServer, type Server } from 'node:http'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Banco } from '../data/db.ts'
import { Automator } from '../engine/automator.ts'
import { PodiumSession } from '../podium/session.ts'
import { parseLinhas } from '../utils/tableParser.ts'
import type { Config } from '../types.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WEB_DIR = join(__dirname, '..', '..', '..', 'web', 'src')

interface Runner {
  parar: () => void
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = Buffer.from(b64, 'base64')
  return bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer
}

export interface StartOpts {
  port?: number
  db?: Banco
}

export async function startServer(opts: StartOpts = {}): Promise<{
  app: express.Express
  server: Server
  banco: Banco
}> {
  const banco = opts.db ?? Banco.abrir()
  const app = express()
  app.use(express.json({ limit: '50mb' }))
  app.use(express.static(WEB_DIR))
  app.use((req, res, next) => {
    res.setHeader('X-Powered-By', 'rifa-automator')
    next()
  })

  const runners = new Map<number, Runner>()

  app.get('/api/health', (_req, res) => res.json({ ok: true }))

  app.get('/api/config', (_req, res) => {
    const c = banco.lerConfig()
    res.json({ configurado: !!c })
  })

  app.post('/api/config', (req, res) => {
    const { cpf, senha, turma } = req.body as Partial<Config>
    if (!cpf || !senha) {
      res.status(400).json({ ok: false, erro: 'cpf e senha obrigatórios' })
      return
    }
    const atual = banco.lerConfig() ?? ({ cpf: '', senha: '', turma: '' } as Config)
    banco.gravarConfig({ cpf, senha, turma: turma ?? atual.turma })
    res.json({ configurado: true })
  })

  app.post('/api/test-login', async (req, res) => {
    const atual = banco.lerConfig()
    const cpf = (req.body?.cpf as string) ?? atual?.cpf
    const senha = (req.body?.senha as string) ?? atual?.senha
    if (!cpf || !senha) {
      res.status(400).json({ ok: false, erro: 'Configure CPF e senha primeiro' })
      return
    }
    try {
      const s = await PodiumSession.login(cpf, senha)
      res.json({ ok: true, turma: s.turma })
    } catch (e) {
      res.json({ ok: false, erro: (e as Error).message })
    }
  })

  app.post('/api/jobs', async (req, res) => {
    try {
      const { arquivo, texto, nomeArquivo } = req.body as {
        arquivo?: string
        texto?: string
        nomeArquivo?: string
      }
      const buf = arquivo ? base64ToArrayBuffer(arquivo) : undefined
      const parsed = await parseLinhas({ arquivo: buf, texto, nomeArquivo })
      if (parsed.invalidas.length) {
        res.status(422).json({ ok: false, invalidas: parsed.invalidas })
        return
      }
      if (parsed.ok.length === 0) {
        res.status(422).json({ ok: false, invalidas: [], erro: 'Nenhuma linha válida' })
        return
      }
      const jobId = banco.criarJob(parsed.ok.map(l => l.pessoa))
      banco.registrarLog(`Job #${jobId} criado com ${parsed.ok.length} rifa(s)`, 'info', jobId)
      res.json({ ok: true, jobId })
    } catch (e) {
      res.status(400).json({ ok: false, erro: (e as Error).message })
    }
  })

  app.get('/api/jobs', (_req, res) => {
    res.json(banco.listarJobs())
  })

  app.get('/api/jobs/:id', (req, res) => {
    const id = Number(req.params.id)
    const job = banco.listarJobs().find(j => j.id === id)
    if (!job) {
      res.status(404).json({ ok: false, erro: 'Job não encontrado' })
      return
    }
    res.json({
      job,
      linhas: banco.linhasDoJob(id),
      resumo: banco.resumoJob(id),
      logs: banco.logs(id, 100),
    })
  })

  async function rodarJob(jobId: number): Promise<void> {
    const config = banco.lerConfig()
    if (!config) return
    let sessao: PodiumSession | null = null
    let deveParar = false
    const parar = () => { deveParar = true }
    runners.set(jobId, { parar })

    try {
      sessao = await PodiumSession.login(config.cpf, config.senha)
      const automator = new Automator({
        getSessao: async () => sessao,
        submeterLinha: async (s, p) => {
          try {
            await (s as PodiumSession).submeterRifa(p)
          } catch {
            const okSessao = await (s as PodiumSession).checarSessao()
            if (!okSessao) sessao = await PodiumSession.login(config.cpf, config.senha)
            throw new Error('sessão renovada, tentando de novo')
          }
        },
        lerMaiorNumero: async s => (s as PodiumSession).lerMaiorNumero(),
        log: (msg, nivel) => banco.registrarLog(msg, nivel ?? 'info', jobId),
        deveParar: () => deveParar,
        onProgress: l => banco.atualizarLinha(l),
      })
      await automator.start(banco.linhasDoJob(jobId), l =>
        banco.atualizarLinha(l)
      )
      banco.atualizarStatusJob(jobId, deveParar ? 'pendente' : 'concluido')
    } catch (e) {
      banco.registrarLog(`Erro ao rodar job #${jobId}: ${(e as Error).message}`, 'error', jobId)
      banco.atualizarStatusJob(jobId, 'pendente')
    } finally {
      runners.delete(jobId)
    }
  }

  app.post('/api/jobs/:id/iniciar', async (req, res) => {
    const id = Number(req.params.id)
    const config = banco.lerConfig()
    if (!config) {
      res.status(400).json({ ok: false, erro: 'Configure o login primeiro' })
      return
    }
    if (runners.has(id)) {
      res.status(409).json({ ok: false, erro: 'Job já está rodando' })
      return
    }
    banco.registrarLog(`Iniciando job #${id}`, 'info', id)
    banco.atualizarStatusJob(id, 'rodando')
    void rodarJob(id)
    res.json({ ok: true })
  })

  app.post('/api/jobs/:id/cancelar', (req, res) => {
    const id = Number(req.params.id)
    runners.get(id)?.parar()
    banco.cancelarJob(id)
    banco.registrarLog('Cancelamento solicitado', 'warn', id)
    res.json({ ok: true })
  })

  app.post('/api/jobs/:id/reprocessar-erros', (req, res) => {
    const id = Number(req.params.id)
    banco.reprocessarErros(id)
    banco.registrarLog('Reprocessando erros', 'info', id)
    res.json({ ok: true })
  })

  const server = createServer(app)
  await new Promise<void>(r => server.listen(opts.port ?? 3000, r))
  return { app, server, banco }
}