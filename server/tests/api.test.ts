import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { startServer, type StartOpts } from '../src/api/server.ts'
import { LEASE_MS } from '../src/data/banco.ts'
import { PodiumSession } from '../src/podium/session.ts'
import { iniciarSiteFalso, type SiteFalso } from './fakes/siteFalso.ts'
import { SqliteBanco } from '../src/data/sqliteBanco.ts'
import type { Pessoa } from '../src/types.ts'

const TEXTO = 'Nome;CPF;Telefone;E-mail;Qtd\nMaria;86730169087;11987654321;m@x.com;1'

async function criarJob(base: string, texto: string): Promise<number> {
  const r = await fetch(`${base}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texto }),
  })
  const j = (await r.json()) as { ok: boolean; jobId: number }
  expect(r.status).toBe(200)
  return j.jobId
}

let srv: ReturnType<typeof Object>
let base: string
let banco: SqliteBanco
let dir: string
let jobTravado: number

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
      body: JSON.stringify({ arquivo: base64, nomeArquivo: 'x.xlsx' }),
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
    jobTravado = id1
  })

  it('cancelar só sinaliza: o job segue rodando até o runner sair', async () => {
    const r = await fetch(`${base}/api/jobs/${jobTravado}/cancelar`, { method: 'POST' })
    expect(await r.json()).toEqual({ ok: true, sinalizado: true })
    const det = await (await fetch(`${base}/api/jobs/${jobTravado}`)).json()
    expect(det.job.status).toBe('rodando')
  })

  it('cancelar job que não está rodando não sinaliza nada', async () => {
    const jobId = await criarJob(base, TEXTO)
    const r = await fetch(`${base}/api/jobs/${jobId}/cancelar`, { method: 'POST' })
    expect(await r.json()).toEqual({ ok: true, sinalizado: false })
  })
})

async function esperar(cond: () => Promise<boolean>, limiteMs = 5000): Promise<void> {
  const ate = Date.now() + limiteMs
  while (!(await cond())) {
    if (Date.now() > ate) throw new Error('condição não atingida a tempo')
    await new Promise(r => setTimeout(r, 20))
  }
}

describe('API rodando job contra o simulador', () => {
  const textoQtd = (qtd: number) => `Nome;CPF;Telefone;E-mail;Qtd\nMaria;86730169087;11987654321;m@x.com;${qtd}`
  let site: SiteFalso
  let dir5: string
  let srv5: Awaited<ReturnType<typeof startServer>>
  let base5: string
  let banco5: SqliteBanco

  async function subir(opts: Parameters<typeof iniciarSiteFalso>[0], extra: Partial<StartOpts> = {}) {
    site = await iniciarSiteFalso(opts)
    dir5 = mkdtempSync(join(tmpdir(), 'rifa-sim-'))
    banco5 = SqliteBanco.abrir(join(dir5, 'test.db'))
    srv5 = await startServer({
      port: 0,
      db: banco5,
      envConfig: { cpf: '86730169087', senha: 'x', turma: '' },
      login: (cpf, senha) => PodiumSession.login(cpf, senha, { baseUrl: site.baseUrl }),
      instancia: 'teste',
      ...extra,
    })
    base5 = `http://127.0.0.1:${(srv5.server.address() as AddressInfo).port}`
  }

  afterEach(async () => {
    srv5.pararTodos()
    await srv5.aguardarRunners(2000)
    srv5.server.close()
    await site.fechar()
    rmSync(dir5, { recursive: true, force: true })
  })

  it('iniciar → exatamente qtd POSTs, linha ok, job concluído e lock liberado', async () => {
    await subir({ proximoNumero: 1129, outrosVendedoresPorEnvio: 3 })
    const id = await criarJob(base5, textoQtd(3))
    expect((await fetch(`${base5}/api/jobs/${id}/iniciar`, { method: 'POST' })).status).toBe(200)
    await esperar(async () => (await (await fetch(`${base5}/api/jobs/${id}`)).json()).job.status === 'concluido')
    expect(site.posts).toHaveLength(3)
    expect((await banco5.linhasDoJob(id))[0]).toMatchObject({ status: 'ok', tentativas: 3, confirmadas: 3 })
    expect(await banco5.lockValido(id)).toBe(false)
  })

  it('perda do lock no meio do lote → para antes do próximo POST', async () => {
    await subir({ proximoNumero: 1129, atrasoPostMs: 150 }, { renovacaoMs: 20 })
    const id = await criarJob(base5, textoQtd(5))
    await fetch(`${base5}/api/jobs/${id}/iniciar`, { method: 'POST' })
    await esperar(async () => site.posts.length >= 1)
    await banco5.liberarLock(id, 'teste', 'pendente') // outra instância "tomou" o job
    await srv5.aguardarRunners(3000)
    expect(site.posts.length).toBeLessThanOrEqual(2)
    const l = (await banco5.linhasDoJob(id))[0]!
    expect(l.status).not.toBe('ok')
    expect(l.tentativas).toBe(site.posts.length)
  })

  it('pararTodos (SIGTERM) → nenhum POST novo e iniciar responde 503', async () => {
    await subir({ proximoNumero: 1129, atrasoPostMs: 100 })
    const id = await criarJob(base5, textoQtd(5))
    await fetch(`${base5}/api/jobs/${id}/iniciar`, { method: 'POST' })
    await esperar(async () => site.posts.length >= 1)
    srv5.pararTodos()
    expect(await srv5.aguardarRunners(3000)).toBe(true)
    const enviados = site.posts.length
    expect(enviados).toBeLessThan(5)
    expect((await banco5.linhasDoJob(id))[0]).toMatchObject({ status: 'pendente', tentativas: enviados, confirmadas: enviados })
    expect((await fetch(`${base5}/api/jobs/${id}/iniciar`, { method: 'POST' })).status).toBe(503)
  })

  const statusJob = async (id: number) => (await (await fetch(`${base5}/api/jobs/${id}`)).json()).job.status as string
  const resolver = (linhaId: number, acao: string) =>
    fetch(`${base5}/api/linhas/${linhaId}/resolver`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ acao }) })

  it('§2.3: envio não confirmado → incerto; conferência mostra a diferença; liberar_reenvio envia só o que falta', async () => {
    await subir({ proximoNumero: 1129, postsSemCriar: 1 })
    const id = await criarJob(base5, textoQtd(2))
    await fetch(`${base5}/api/jobs/${id}/iniciar`, { method: 'POST' })
    await esperar(async () => (await statusJob(id)) === 'pendente')
    const l = (await banco5.linhasDoJob(id))[0]!
    expect(l).toMatchObject({ status: 'incerto', tentativas: 1, confirmadas: 0 })
    expect(site.posts).toHaveLength(1)

    const conf = await (await fetch(`${base5}/api/jobs/${id}/conferencia`)).json()
    expect(conf.linhas[0]).toMatchObject({ status: 'incerto', qtd: 2, base_cpf: 0, tentativas: 1, site: 0, desdeBase: 0 })

    // Reprocessar erros não toca na linha incerta.
    await fetch(`${base5}/api/jobs/${id}/reprocessar-erros`, { method: 'POST' })
    expect((await banco5.linhasDoJob(id))[0]?.status).toBe('incerto')

    const r = await resolver(l.id, 'liberar_reenvio')
    expect(await r.json()).toEqual({ ok: true, confirmadas: 0, faltam: 2 })
    expect((await banco5.linhasDoJob(id))[0]).toMatchObject({ status: 'pendente', tentativas: 0, confirmadas: 0 })

    await fetch(`${base5}/api/jobs/${id}/iniciar`, { method: 'POST' })
    await esperar(async () => (await statusJob(id)) === 'concluido')
    expect(site.posts.filter(p => p.numero > 0)).toHaveLength(2)
    expect((await banco5.linhasDoJob(id))[0]?.status).toBe('ok')
  })

  it('§2.3: liberar_reenvio é recusado quando o site já mostra as rifas; marcar_ok resolve', async () => {
    await subir({ proximoNumero: 1129 })
    const id = await criarJob(base5, textoQtd(1))
    await fetch(`${base5}/api/jobs/${id}/iniciar`, { method: 'POST' })
    await esperar(async () => (await statusJob(id)) === 'concluido')
    const l = (await banco5.linhasDoJob(id))[0]!
    // Simula a linha ter ficado incerta mesmo com a rifa criada (ex.: medição pós-envio falhou).
    await banco5.atualizarLinha({ ...l, status: 'incerto', confirmadas: 0 })

    const r1 = await resolver(l.id, 'liberar_reenvio')
    expect(r1.status).toBe(409)
    expect((await r1.json()).erro).toMatch(/já mostra 1 rifa/)
    expect(site.posts).toHaveLength(1)

    expect((await resolver(l.id, 'marcar_ok')).status).toBe(200)
    expect((await banco5.linhasDoJob(id))[0]?.status).toBe('ok')
    expect((await resolver(l.id, 'marcar_ok')).status).toBe(409) // não está mais incerta
    expect((await resolver(l.id, 'apagar')).status).toBe(400)
  })

  it('§2.3: conferência e resolução recusadas com job rodando', async () => {
    await subir({ proximoNumero: 1129 })
    const id = await criarJob(base5, textoQtd(1))
    const l = (await banco5.linhasDoJob(id))[0]!
    await banco5.atualizarLinha({ ...l, status: 'incerto', base_cpf: 0, tentativas: 1 })
    const outro = await criarJob(base5, textoQtd(1))
    await banco5.tentarIniciarJob(outro, 'outra-instancia')
    expect((await fetch(`${base5}/api/jobs/${id}/conferencia`)).status).toBe(409)
    expect((await resolver(l.id, 'liberar_reenvio')).status).toBe(409)
    expect(site.posts).toHaveLength(0)
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
  it('job rodando com lock expirado volta a pendente; linha sem envio pendente volta a pendente', async () => {
    const dir4 = mkdtempSync(join(tmpdir(), 'rifa-boot-'))
    const b = SqliteBanco.abrir(join(dir4, 'test.db'))
    const id = await b.criarJob([{ nome: 'Maria', cpf: '86730169087', telefone: '11987654321', email: 'm@x.com', qtd: 1 }])
    await b.tentarIniciarJob(id, 'antiga', Date.now() - 2 * LEASE_MS)
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

  it('não libera lock válido de outra instância (deploy sobreposto)', async () => {
    const dir4 = mkdtempSync(join(tmpdir(), 'rifa-boot-'))
    const b = SqliteBanco.abrir(join(dir4, 'test.db'))
    const id = await b.criarJob([{ nome: 'Maria', cpf: '86730169087', telefone: '11987654321', email: 'm@x.com', qtd: 1 }])
    await b.tentarIniciarJob(id, 'antiga')
    const linha = (await b.linhasDoJob(id))[0]!
    await b.atualizarLinha({ ...linha, status: 'cadastrando', base_cpf: 0, tentativas: 1 })
    const srv4 = await startServer({ port: 0, db: b, envConfig: { cpf: '86730169087', senha: 'x', turma: '' } })
    const base4 = `http://127.0.0.1:${(srv4.server.address() as AddressInfo).port}`
    try {
      const det = await (await fetch(`${base4}/api/jobs/${id}`)).json()
      expect(det.job.status).toBe('rodando')
      expect(det.linhas[0].status).toBe('cadastrando')
      expect((await fetch(`${base4}/api/jobs/${id}/iniciar`, { method: 'POST' })).status).toBe(409)
    } finally {
      srv4.server.close()
      rmSync(dir4, { recursive: true, force: true })
    }
  })
})
