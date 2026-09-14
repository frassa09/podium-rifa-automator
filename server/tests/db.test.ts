import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { abrirBanco, type Banco } from '../src/data/abrirBanco.ts'
import { SqliteBanco } from '../src/data/sqliteBanco.ts'
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