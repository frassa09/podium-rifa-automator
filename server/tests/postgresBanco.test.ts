import { afterAll, beforeAll, describe } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { PostgresBanco, traduzirMarcadores } from '../src/data/postgresBanco.ts'
import type { Banco, QueryExecutor } from '../src/data/banco.ts'
import { suíteComumBanco } from './suites/bancoComum.ts'

class ExecutorPGlite implements QueryExecutor {
  constructor(private pg: PGlite) {}

  async rows<T = unknown>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    const r = await this.pg.query<T>(traduzirMarcadores(sql), params as never[])
    return r.rows
  }

  async changes(sql: string, params: readonly unknown[] = []): Promise<number> {
    const r = await this.pg.query<unknown>(traduzirMarcadores(sql), params as never[])
    const afetadas = (r as unknown as { affectedRows?: bigint | number }).affectedRows
    return Number(afetadas ?? 0)
  }

  async exec(sql: string): Promise<void> {
    await this.pg.exec(sql)
  }

  async transacao<T>(fn: () => Promise<T>): Promise<T> {
    await this.pg.exec('BEGIN')
    try {
      const r = await fn()
      await this.pg.exec('COMMIT')
      return r
    } catch (e) {
      await this.pg.exec('ROLLBACK')
      throw e
    }
  }

  async fechar(): Promise<void> {}
}

describe('PostgresBanco via PGlite', () => {
  let pg: PGlite

  beforeAll(async () => {
    pg = new PGlite()
  })

  afterAll(async () => {
    await pg.close()
  })

  const novo = async (): Promise<Banco> => PostgresBanco.abrirComExecutor(new ExecutorPGlite(pg))

  suíteComumBanco(novo)
})