import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { startServer } from '../src/api/server.ts'
import { SqliteBanco } from '../src/data/sqliteBanco.ts'
import { criarLimitador } from '../src/utils/limitador.ts'
import type { PodiumSession } from '../src/podium/session.ts'
import type { Pessoa } from '../src/types.ts'

const TEXTO = 'Nome;CPF;Telefone;E-mail;Qtd\nMaria;86730169087;11987654321;m@x.com;1'

async function criarJob(base: string, texto: string): Promise<number> {
  const r = await fetch(`${base}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texto, forcar: true }),
  })
  const j = (await r.json()) as { ok: boolean; jobId: number }
  expect(r.status).toBe(200)
  return j.jobId
}

let srv: ReturnType<typeof Object>
let base: string
let banco: SqliteBanco
let dir: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rifa-api-'))
  banco = SqliteBanco.abrir(join(dir, 'test.db'))
  // login nunca resolve: mantém o job 'rodando' para testar single-flight sem site real
  srv = await startServer({ port: 0, db: banco, login: () => new Promise<PodiumSession>(() => {}) })
  base = `http://127.0.0.1:${(srv.server.address() as AddressInfo).port}`
})

afterAll(() => {
  srv.server.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('API', () => {
  it('health ok', async () => {
    const r = await fetch(`${base}/api/health`)
    expect(await r.json()).toEqual({ ok: true })
  })

  it('salva config sem expor senha', async () => {
    const r1 = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cpf: '86730169087', senha: 'segredo', turma: '6474' }),
    })
    expect(await r1.json()).toEqual({ configurado: true })
    const r2 = await fetch(`${base}/api/config`)
    const c2 = await r2.json()
    expect(c2.configurado).toBe(true)
    expect(c2.cpf).toBe('86730169087')
    expect('senha' in c2).toBe(false)
  })

  it('cria job a partir de texto e lista', async () => {
    const id = await criarJob(base, TEXTO)
    expect(typeof id).toBe('number')
    const jobs = await (await fetch(`${base}/api/jobs`)).json()
    expect(Array.isArray(jobs)).toBe(true)
    expect((jobs as { id: number }[]).some(j => j.id === id)).toBe(true)
  })

  it('retorna 422 em linhas inválidas', async () => {
    const r = await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texto: 'Nome;CPF;Telefone;E-mail\n;123;1;x' }),
    })
    expect(r.status).toBe(422)
    const j = await r.json()
    expect(j.ok).toBe(false)
    expect(Array.isArray(j.invalidas)).toBe(true)
  })

  it('rejeita qtd acima do teto (MAX_QUANTIDADE=100)', async () => {
    const r = await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pessoas: [{ nome: 'Zé', cpf: '86730169087', telefone: '11987654321', email: 'ze@x.com', qtd: 150 }],
      }),
    })
    expect(r.status).toBe(422)
    const j = await r.json()
    expect(j.invalidas[0].erros.join(' ')).toContain('Qtd máxima por pessoa é 100')
  })

  it('semCriar retorna preview sem criar job', async () => {
    const antes = (await (await fetch(`${base}/api/jobs`)).json()) as unknown[]
    const r = await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        texto: 'Nome;CPF;Telefone;E-mail;Qtd\nMaria;86730169087;11987654321;m@x.com;3\nJoão;86730169087;11987654321;j@x.com;2',
        semCriar: true,
        forcar: true,
      }),
    })
    expect(r.status).toBe(200)
    const prev = await r.json()
    expect(prev.preview).toBe(true)
    expect(prev.totalRifas).toBe(5)
    expect(prev.linhas).toBe(2)
    const depois = (await (await fetch(`${base}/api/jobs`)).json()) as unknown[]
    expect(depois.length).toBe(antes.length)
  })

  it('detalha job com linhas e resumo', async () => {
    const jobId = await criarJob(base, TEXTO)
    const det = await (await fetch(`${base}/api/jobs/${jobId}`)).json()
    expect(det.job).toBeTruthy()
    expect(det.linhas).toHaveLength(1)
    expect(det.resumo.total).toBe(1)
  })

  it('cria job a partir de base64 xlsx', async () => {
    const XLSX = await import('xlsx')
    const ws = XLSX.utils.aoa_to_sheet([['Nome', 'CPF', 'Telefone', 'E-mail', 'Qtd'], ['Ana', '86730169087', '11987654321', 'ana@x.com', 2]])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'a')
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
    const base64 = Buffer.from(new Uint8Array(buf)).toString('base64')
    const r = await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ arquivo: base64, nomeArquivo: 'x.xlsx', forcar: true }),
    })
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.jobId).toBeTruthy()
  })

  it('cria job a partir de lista manual', async () => {
    const r = await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pessoas: [
          { nome: 'João', cpf: '867.301.690-87', telefone: '(11) 98765-4321', email: 'joao@x.com', qtd: 2 },
          { nome: 'Maria', cpf: '86730169087', telefone: '11987654321', email: 'maria@x.com', qtd: '1' },
        ] as Pessoa[],
        forcar: true,
      }),
    })
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.jobId).toBeTruthy()
    const det = await (await fetch(`${base}/api/jobs/${j.jobId}`)).json()
    expect(det.linhas).toHaveLength(2)
    expect(det.linhas[0].cpf).toBe('86730169087')
    expect(det.linhas[0].qtd).toBe(2)
    expect(det.linhas[1].qtd).toBe(1)
  })

  it('rejeita pessoas inválidas no manual', async () => {
    const r = await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pessoas: [
          { nome: 'Zé', cpf: '123', telefone: '1', email: 'x', qtd: 0 },
          { nome: 'Boa', cpf: '86730169087', telefone: '11987654321', email: 'boa@x.com', qtd: 1 },
        ],
      }),
    })
    expect(r.status).toBe(422)
    const j = await r.json()
    expect(j.ok).toBe(false)
    expect(j.invalidas).toHaveLength(1)
    expect(j.invalidas[0].erros.length).toBeGreaterThan(0)
  })

  it('single-flight: segundo iniciar recebe 409', async () => {
    await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cpf: '86730169087', senha: 'x', turma: '6474' }),
    })
    const id1 = await criarJob(base, TEXTO)
    const id2 = await criarJob(base, TEXTO)
    const r1 = await fetch(`${base}/api/jobs/${id1}/iniciar`, { method: 'POST' })
    expect(r1.status).toBe(200)
    const r2 = await fetch(`${base}/api/jobs/${id2}/iniciar`, { method: 'POST' })
    expect(r2.status).toBe(409)
    await banco.cancelarJob(id1)
  })

  it('cancela job rodando e fica pendente', async () => {
    const jobId = await criarJob(base, TEXTO)
    await banco.atualizarStatusJob(jobId, 'rodando')
    const r2 = await fetch(`${base}/api/jobs/${jobId}/cancelar`, { method: 'POST' })
    expect(await r2.json()).toEqual({ ok: true })
    const det = await (await fetch(`${base}/api/jobs/${jobId}`)).json()
    expect(det.job.status).toBe('pendente')
  })
})

describe('API com PIN', () => {
  let srv2: ReturnType<typeof Object>
  let base2: string
  let dir2: string

  beforeAll(async () => {
    dir2 = mkdtempSync(join(tmpdir(), 'rifa-pin-'))
    const banco2 = SqliteBanco.abrir(join(dir2, 'test.db'))
    srv2 = await startServer({ port: 0, db: banco2, pin: '1234' })
    base2 = `http://127.0.0.1:${(srv2.server.address() as AddressInfo).port}`
  })

  afterAll(() => {
    srv2.server.close()
    rmSync(dir2, { recursive: true, force: true })
  })

  it('health e estáticos são públicos sem PIN', async () => {
    expect((await fetch(`${base2}/api/health`)).status).toBe(200)
    const html = await fetch(`${base2}/index.html`)
    expect(html.status).toBe(200)
    expect(await html.text()).toContain('Rifa Automator')
  })

  it('exige X-PIN nas rotas de API; PIN correto libera', async () => {
    expect((await fetch(`${base2}/api/config`)).status).toBe(401)
    expect((await fetch(`${base2}/api/config`, { headers: { 'X-PIN': 'errado' } })).status).toBe(401)
    const ok = await fetch(`${base2}/api/config`, { headers: { 'X-PIN': '1234' } })
    expect(ok.status).toBe(200)
    expect((await ok.json()).configurado).toBe(false)
  })

  it('envia cabeçalhos de segurança e no-store na API', async () => {
    const r = await fetch(`${base2}/api/health`)
    expect(r.headers.get('content-security-policy')).toContain("default-src 'self'")
    expect(r.headers.get('x-frame-options')).toBe('DENY')
    expect(r.headers.get('cache-control')).toBe('no-store')
    expect(r.headers.get('x-powered-by')).toBeNull()
  })

  it('corpo grande sem PIN é recusado antes de ser lido', async () => {
    const r = await fetch(`${base2}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texto: 'x'.repeat(20 * 1024 * 1024) }),
    })
    expect(r.status).toBe(401)
  })
})

describe('API com PIN — trava anti força-bruta', () => {
  let srv4: ReturnType<typeof Object>
  let base4: string
  let dir4: string

  beforeAll(async () => {
    dir4 = mkdtempSync(join(tmpdir(), 'rifa-trava-'))
    const banco4 = SqliteBanco.abrir(join(dir4, 'test.db'))
    srv4 = await startServer({ port: 0, db: banco4, pin: '73915482', limitadorPin: criarLimitador({ maxFalhas: 2 }) })
    base4 = `http://127.0.0.1:${(srv4.server.address() as AddressInfo).port}`
  })

  afterAll(() => {
    srv4.server.close()
    rmSync(dir4, { recursive: true, force: true })
  })

  it('bloqueia o IP após falhas seguidas, inclusive com o PIN certo', async () => {
    const tentar = (p: string) => fetch(`${base4}/api/config`, { headers: { 'X-PIN': p } })
    expect((await fetch(`${base4}/api/config`)).status).toBe(401) // sem PIN não conta
    expect((await tentar('errado1')).status).toBe(401)
    expect((await tentar('errado2')).status).toBe(401)
    const bloqueado = await tentar('73915482')
    expect(bloqueado.status).toBe(429)
    expect(Number(bloqueado.headers.get('retry-after'))).toBeGreaterThan(0)
    expect((await fetch(`${base4}/api/health`)).status).toBe(200)
  })
})

describe('API com credenciais via ambiente', () => {
  let srv3: ReturnType<typeof Object>
  let base3: string
  let dir3: string

  beforeAll(async () => {
    dir3 = mkdtempSync(join(tmpdir(), 'rifa-env-'))
    const banco3 = SqliteBanco.abrir(join(dir3, 'test.db'))
    srv3 = await startServer({
      port: 0,
      db: banco3,
      envConfig: { cpf: '86730169087', senha: 'segredo', turma: '6474' },
    })
    base3 = `http://127.0.0.1:${(srv3.server.address() as AddressInfo).port}`
  })

  afterAll(() => {
    srv3.server.close()
    rmSync(dir3, { recursive: true, force: true })
  })

  it('GET /api/config expõe viaAmbiente e nunca a senha', async () => {
    const c = await (await fetch(`${base3}/api/config`)).json()
    expect(c.configurado).toBe(true)
    expect(c.viaAmbiente).toBe(true)
    expect(c.cpf).toBe('86730169087')
    expect('senha' in c).toBe(false)
  })

  it('recusa escrita de config com 409', async () => {
    const r = await fetch(`${base3}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cpf: '12345678900', senha: 'x' }),
    })
    expect(r.status).toBe(409)
  })
})

describe('reconciliação no boot', () => {
  it('rodando e cadastrando voltam a pendente ao subir o servidor', async () => {
    const dir4 = mkdtempSync(join(tmpdir(), 'rifa-boot-'))
    const b = SqliteBanco.abrir(join(dir4, 'test.db'))
    const id = await b.criarJob([{ nome: 'Maria', cpf: '86730169087', telefone: '11987654321', email: 'm@x.com', qtd: 1 }])
    await b.atualizarStatusJob(id, 'rodando')
    const linha = (await b.linhasDoJob(id))[0]!
    await b.atualizarLinha({ ...linha, status: 'cadastrando' })
    const srv4 = await startServer({ port: 0, db: b })
    const base4 = `http://127.0.0.1:${(srv4.server.address() as AddressInfo).port}`
    try {
      const det = await (await fetch(`${base4}/api/jobs/${id}`)).json()
      expect(det.job.status).toBe('pendente')
      expect(det.linhas[0].status).toBe('pendente')
    } finally {
      srv4.server.close()
      rmSync(dir4, { recursive: true, force: true })
    }
  })
})