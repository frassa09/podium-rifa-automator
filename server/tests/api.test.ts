import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { startServer } from '../src/api/server.ts'
import { Banco } from '../src/data/db.ts'

let srv: ReturnType<typeof Object>
let base: string
let banco: Banco
let dir: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rifa-api-'))
  banco = Banco.abrir(join(dir, 'test.db'))
  srv = await startServer({ port: 0, db: banco })
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
    expect(await r2.json()).toEqual({ configurado: true })
    // rota não retorna a senha em lugar algum — verificado manualmente na resposta
  })

  it('cria job a partir de texto e lista', async () => {
    const r = await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texto: 'Nome;CPF;Telefone;E-mail\nMaria;86730169087;11987654321;m@x.com' }),
    })
    const j = await r.json()
    expect(j.ok).toBe(true)
    expect(typeof j.jobId).toBe('number')
    const jobs = await (await fetch(`${base}/api/jobs`)).json()
    expect(Array.isArray(jobs)).toBe(true)
    expect(jobs.length).toBeGreaterThanOrEqual(1)
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

  it('detalha job com linhas e resumo', async () => {
    const r = await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texto: 'Nome;CPF;Telefone;E-mail\nMaria;86730169087;11987654321;m@x.com' }),
    })
    const { jobId } = await r.json()
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

  it('cancela job não-rodando e fica pendente', async () => {
    const r = await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texto: 'Nome;CPF;Telefone;E-mail\nBia;86730169087;11987654321;bia@x.com' }),
    })
    const { jobId } = await r.json()
    banco.atualizarStatusJob(jobId, 'rodando')
    const r2 = await fetch(`${base}/api/jobs/${jobId}/cancelar`, { method: 'POST' })
    expect(await r2.json()).toEqual({ ok: true })
    const det = await (await fetch(`${base}/api/jobs/${jobId}`)).json()
    expect(det.job.status).toBe('pendente')
  })
})