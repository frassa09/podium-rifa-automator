import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { abrirBanco, type Banco } from '../src/data/abrirBanco.ts'
import { SqliteBanco } from '../src/data/sqliteBanco.ts'
import { linhaLegada } from '../src/data/banco.ts'
import Database from 'better-sqlite3'
import { suíteComumBanco } from './suites/bancoComum.ts'

const dirs: string[] = []

function novoBanco(): Banco {
  const dir = mkdtempSync(join(tmpdir(), 'rifa-test-'))
  dirs.push(dir)
  return SqliteBanco.abrir(join(dir, 'test.db'))
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

describe('SqliteBanco', () => {
  suíteComumBanco(async () => novoBanco())

  it('migra banco do formato antigo e marca a linha do incidente como legada', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rifa-mig-'))
    dirs.push(dir)
    const caminho = join(dir, 'antigo.db')
    const db = new Database(caminho)
    db.exec(`CREATE TABLE jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT NOT NULL DEFAULT 'pendente',
               criado_em TEXT NOT NULL DEFAULT (datetime('now')), total INTEGER NOT NULL DEFAULT 0);
             CREATE TABLE job_linhas (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id INTEGER NOT NULL, seq INTEGER NOT NULL,
               nome TEXT NOT NULL, cpf TEXT NOT NULL, telefone TEXT NOT NULL, email TEXT NOT NULL, qtd INTEGER NOT NULL DEFAULT 1,
               status TEXT NOT NULL DEFAULT 'pendente', erro TEXT, numeros TEXT NOT NULL DEFAULT '', base INTEGER,
               enviadas INTEGER NOT NULL DEFAULT 0);
             INSERT INTO jobs (status, total) VALUES ('pendente', 1);
             INSERT INTO job_linhas (job_id, seq, nome, cpf, telefone, email, qtd, status, erro, base)
               VALUES (1, 1, 'A', '86730169087', '11987654321', 'a@b.com', 1, 'erro', 'site não registrou a submissão (Nº 0→0)', 0);`)
    db.close()
    const banco = SqliteBanco.abrir(caminho)
    const [l] = await banco.linhasDoJob(1)
    expect([l!.base_cpf, l!.confirmadas]).toEqual([null, 0])
    expect(linhaLegada(l!)).toBe(true)
    expect(await banco.reprocessarErros(1)).toBe(0)
  })

  it('abrirBanco sem DATABASE_URL devolve SqliteBanco (modo LAN)', async () => {
    const urlAntigo = process.env.DATABASE_URL
    delete process.env.DATABASE_URL
    try {
      const banco = await abrirBanco({ caminho: join(dirs[0]!, 'fab.db') })
      expect(banco).toBeInstanceOf(SqliteBanco)
    } finally {
      if (urlAntigo !== undefined) process.env.DATABASE_URL = urlAntigo
    }
  })
})