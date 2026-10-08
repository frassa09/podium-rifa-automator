// Fluxo real de ponta a ponta: API HTTP → servidor → motor → PodiumSession → site falso
// (HTML idêntico ao real, em ISO-8859-1). Nada é mockado entre a API e o HTTP do site.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { startServer } from '../src/api/server.ts'
import { SqliteBanco } from '../src/data/sqliteBanco.ts'
import { PodiumSession } from '../src/podium/session.ts'
import { criarSiteFalso, type SiteFalso } from './fixtures/siteFalso.ts'
import { rifa } from './fixtures/formRifa.ts'

const MARIA = { nome: 'Maria José', cpf: '86730169087', telefone: '11987654321', email: 'm@x.com' }
const JOAO = { nome: 'João', cpf: '11144477735', telefone: '11987654321', email: 'j@x.com' }

let site: SiteFalso
let banco: SqliteBanco
let dir: string
let srv: Awaited<ReturnType<typeof startServer>>
let base: string

async function api<T = Record<string, unknown>>(path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const r = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: r.status, json: (await r.json()) as T }
}

interface Detalhe {
  job: { status: string }
  linhas: { status: string; erro: string | null; confirmadas: number; enviadas: number; numeros: string }[]
  logs: string[]
}

async function rodarAteParar(jobId: number): Promise<Detalhe> {
  const r = await api(`/api/jobs/${jobId}/iniciar`, {})
  expect(r.status).toBe(200)
  for (let i = 0; i < 400; i++) {
    await new Promise(res => setTimeout(res, 25))
    const d = (await api<Detalhe>(`/api/jobs/${jobId}`)).json
    if (d.job.status !== 'rodando') return d
  }
  throw new Error('job não terminou')
}

const postsDe = (cpfMascarado: string) => site.posts.filter(p => p.includes(encodeURIComponent(cpfMascarado))).length

beforeEach(async () => {
  site = await criarSiteFalso([rifa(1003, '867.301.690-87'), rifa(1004, '999.999.999-99'.replace(/9/g, '1'))])
  dir = mkdtempSync(join(tmpdir(), 'rifa-fluxo-'))
  banco = SqliteBanco.abrir(join(dir, 'test.db'))
  srv = await startServer({
    port: 0,
    db: banco,
    envConfig: { cpf: '86730169087', senha: 'senha', turma: '' },
    login: (cpf, senha) => PodiumSession.login(cpf, senha, { baseUrl: site.base }),
  })
  base = `http://127.0.0.1:${(srv.server.address() as AddressInfo).port}`
})

afterEach(async () => {
  srv.server.close()
  await site.fechar()
  rmSync(dir, { recursive: true, force: true })
})

describe('fluxo completo', () => {
  it('cria exatamente o pedido e marca o job concluído com os Nºs', async () => {
    const { json } = await api<{ jobId: number }>('/api/jobs', { pessoas: [{ ...MARIA, qtd: 2 }, { ...JOAO, qtd: 1 }] })
    const d = await rodarAteParar(json.jobId)
    expect(d.job.status).toBe('concluido')
    expect(site.posts).toHaveLength(3)
    expect(postsDe('867.301.690-87')).toBe(2)
    expect(d.linhas.map(l => [l.status, l.confirmadas])).toEqual([['ok', 2], ['ok', 1]])
    expect(d.linhas[0]!.numeros.split(', ')).toHaveLength(2)
    expect(site.rifas.at(-3)!.nome).toBe('Maria José') // acento chegou certo
  })

  it('REGRESSÃO do incidente: site não mostra a rifa nova → 1 envio só e job parado com erro claro', async () => {
    site.esconderRecentes = 1000
    const { json } = await api<{ jobId: number }>('/api/jobs', { pessoas: [{ ...MARIA, qtd: 1 }] })
    const d = await rodarAteParar(json.jobId)
    expect(site.posts).toHaveLength(1)
    expect(d.job.status).toBe('pendente')
    expect(d.linhas[0]!.status).toBe('erro')
    expect(d.linhas[0]!.erro).toMatch(/Confira no site/)

    // Iniciar de novo sem reprocessar: linha em erro não é reenviada.
    await rodarAteParar(json.jobId)
    expect(site.posts).toHaveLength(1)
  }, 20_000)

  it('reprocessar depois que o site passou a mostrar a rifa: reconta e NÃO reenvia', async () => {
    site.esconderRecentes = 1000
    const { json } = await api<{ jobId: number }>('/api/jobs', { pessoas: [{ ...MARIA, qtd: 1 }] })
    await rodarAteParar(json.jobId)
    site.esconderRecentes = 0
    expect((await api(`/api/jobs/${json.jobId}/reprocessar-erros`, {})).json).toMatchObject({ liberadas: 1 })
    const d = await rodarAteParar(json.jobId)
    expect(site.posts).toHaveLength(1)
    expect(d.linhas[0]!.status).toBe('ok')
    expect(d.job.status).toBe('concluido')
  }, 20_000)

  it('site ignorou o POST de verdade: reprocessar libera exatamente o que falta', async () => {
    site.postsIgnorados = 1
    const { json } = await api<{ jobId: number }>('/api/jobs', { pessoas: [{ ...MARIA, qtd: 2 }] })
    let d = await rodarAteParar(json.jobId)
    expect(site.posts).toHaveLength(1)
    expect(d.linhas[0]!.status).toBe('erro')
    await api(`/api/jobs/${json.jobId}/reprocessar-erros`, {})
    d = await rodarAteParar(json.jobId)
    expect(d.linhas[0]!.status).toBe('ok')
    expect(postsDe('867.301.690-87')).toBe(3) // 1 ignorado + 2 criados
    expect(site.rifas.filter(r => r.cpf === '867.301.690-87')).toHaveLength(3) // 1 antiga + 2 novas
  }, 20_000)

  it('conexão cai na resposta do POST (rifa criada): conta pela tabela e não duplica', async () => {
    site.derrubarRespostaPost = true
    const { json } = await api<{ jobId: number }>('/api/jobs', { pessoas: [{ ...MARIA, qtd: 2 }] })
    const d = await rodarAteParar(json.jobId)
    expect(site.posts).toHaveLength(2)
    expect(d.linhas[0]!.status).toBe('ok')
  })

  it('página do site quebrada: nenhum envio', async () => {
    site.paginaQuebrada = true
    const { json } = await api<{ jobId: number }>('/api/jobs', { pessoas: [{ ...MARIA, qtd: 1 }] })
    const d = await rodarAteParar(json.jobId)
    expect(site.posts).toHaveLength(0)
    expect(d.linhas[0]!.erro).toMatch(/não foi possível ler/)
  })

  it('linha criada pela versão antiga não é reprocessada nem reenviada', async () => {
    const { json } = await api<{ jobId: number }>('/api/jobs', { pessoas: [{ ...MARIA, qtd: 1 }] })
    const [l] = await banco.linhasDoJob(json.jobId)
    // Estado exato que a versão antiga deixou no incidente.
    const db = new Database(join(dir, 'test.db'))
    db.prepare('UPDATE job_linhas SET base = 0, status = ?, erro = ? WHERE id = ?').run('erro', 'site não registrou a submissão (Nº 0→0)', l!.id)
    db.close()
    expect((await api(`/api/jobs/${json.jobId}/reprocessar-erros`, {})).json).toMatchObject({ liberadas: 0 })
    const d = await rodarAteParar(json.jobId)
    expect(site.posts).toHaveLength(0)
    expect(d.linhas[0]!.status).toBe('erro')
  })

  it('segundo job para quem tem linha em aberto exige confirmação explícita (forcar)', async () => {
    site.esconderRecentes = 1000
    const j1 = (await api<{ jobId: number }>('/api/jobs', { pessoas: [{ ...MARIA, qtd: 1 }] })).json.jobId
    await rodarAteParar(j1) // linha fica em erro (não confirmada)
    const r = await api<{ conflitos: { job_id: number }[] }>('/api/jobs', { pessoas: [{ ...MARIA, qtd: 1 }, { ...JOAO, qtd: 1 }] })
    expect(r.status).toBe(409)
    expect(r.json.conflitos).toEqual([{ job_id: j1, nome: MARIA.nome, cpf: MARIA.cpf }])
    const previa = await api('/api/jobs', { pessoas: [{ ...MARIA, qtd: 1 }], semCriar: true })
    expect(previa.status).toBe(409)
    const forcado = await api('/api/jobs', { pessoas: [{ ...MARIA, qtd: 1 }], forcar: true })
    expect(forcado.status).toBe(200)
  }, 20_000)

  it('nome com emoji é recusado na criação do job (antes de qualquer envio)', async () => {
    const r = await api('/api/jobs', { pessoas: [{ ...MARIA, nome: 'Maria 🎉', qtd: 1 }] })
    expect(r.status).toBe(422)
  })
})
