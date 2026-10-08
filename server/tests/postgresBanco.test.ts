import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { PostgresBanco, PostgresExecutor, traduzirMarcadores, type ConexaoPg, type PoolPg } from '../src/data/postgresBanco.ts'
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
// Conexão estilo node-postgres sobre PGlite: exercita o PostgresExecutor real.
function conexaoPGlite(pg: PGlite, onRelease: (destruir?: boolean) => void = () => {}): ConexaoPg {
  return {
    query: async (sql, params) => {
      if (params?.length) {
        const r = await pg.query(sql, params)
        return { rows: r.rows, rowCount: Number(r.affectedRows ?? 0) }
      }
      const rs = await pg.exec(sql)
      const ultimo = rs[rs.length - 1]
      return { rows: ultimo?.rows ?? [], rowCount: Number(ultimo?.affectedRows ?? 0) }
    },
    release: onRelease,
  }
}

describe('PostgresExecutor (pool) via PGlite', () => {
  let pg: PGlite

  beforeAll(async () => {
    pg = new PGlite()
  })

  afterAll(async () => {
    await pg.close()
  })

  const pool = (): PoolPg => ({ connect: async () => conexaoPGlite(pg), end: async () => {} })
  const novo = async (): Promise<Banco> => PostgresBanco.abrirComExecutor(new PostgresExecutor(pool()))

  suíteComumBanco(novo)
})

describe('PostgresExecutor — queda de conexão (Neon ocioso)', () => {
  let pg: PGlite

  beforeAll(async () => {
    pg = new PGlite()
  })

  afterAll(async () => {
    await pg.close()
  })

  it('descarta a conexão que falhou e usa outra na próxima operação', async () => {
    const releases: (boolean | undefined)[] = []
    let n = 0
    const pool: PoolPg = {
      connect: async () => {
        n++
        const c = conexaoPGlite(pg, d => releases.push(d))
        if (n === 1) return { ...c, query: async () => { throw new Error('Connection terminated unexpectedly') } }
        return c
      },
      end: async () => {},
    }
    const ex = new PostgresExecutor(pool, 3, 0)
    await expect(ex.rows('SELECT 1 AS um')).rejects.toThrow(/Connection terminated/)
    expect(await ex.rows<{ um: number }>('SELECT 1 AS um')).toEqual([{ um: 1 }])
    expect(releases).toEqual([true, false])
  })

  it('re-tenta obter conexão no cold start, sem repetir a query', async () => {
    let tentativas = 0
    const pool: PoolPg = {
      connect: async () => {
        if (++tentativas < 3) throw new Error('timeout')
        return conexaoPGlite(pg)
      },
      end: async () => {},
    }
    const ex = new PostgresExecutor(pool, 3, 0)
    expect(await ex.rows<{ um: number }>('SELECT 1 AS um')).toEqual([{ um: 1 }])
    expect(tentativas).toBe(3)
  })

  it('transação usa uma única conexão e reverte em erro', async () => {
    let conexoes = 0
    const pool: PoolPg = { connect: async () => (conexoes++, conexaoPGlite(pg)), end: async () => {} }
    const ex = new PostgresExecutor(pool, 1, 0)
    await ex.exec('CREATE TABLE t (v INT)')
    conexoes = 0
    await expect(
      ex.transacao(async () => {
        await ex.changes('INSERT INTO t (v) VALUES (?)', [1])
        throw new Error('falha no meio')
      }),
    ).rejects.toThrow('falha no meio')
    expect(conexoes).toBe(1)
    expect(await ex.rows('SELECT * FROM t')).toEqual([])
  })
})
