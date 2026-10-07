import { describe, expect, it } from 'vitest'
import type { Pool, PoolClient } from 'pg'
import { PostgresExecutor } from '../src/data/postgresBanco.ts'

// Pool falso: registra em qual cliente cada SQL rodou e como cada cliente foi devolvido.
function poolFalso(falharEm?: string) {
  const execucoes: { cliente: number; sql: string }[] = []
  const devolucoes: { cliente: number; destruir: boolean }[] = []
  let proximo = 0
  const pool = {
    connect: async () => {
      const id = ++proximo
      return {
        query: async (sql: string) => {
          await new Promise(r => setTimeout(r, 5))
          execucoes.push({ cliente: id, sql })
          if (falharEm && sql.includes(falharEm)) throw new Error('Connection terminated unexpectedly')
          return { rows: [], rowCount: 1 }
        },
        release: (destruir?: boolean) => { devolucoes.push({ cliente: id, destruir: Boolean(destruir) }) },
      } as unknown as PoolClient
    },
    end: async () => {},
  } as unknown as Pool
  return { pool, execucoes, devolucoes }
}

describe('PostgresExecutor (pg.Pool)', () => {
  it('transação fica presa a um cliente; consulta concorrente de fora usa outro', async () => {
    const { pool, execucoes } = poolFalso()
    const e = new PostgresExecutor(pool)
    let liberar: () => void = () => {}
    const meio = new Promise<void>(r => { liberar = r })
    const tx = e.transacao(async () => {
      await e.changes('UPDATE dentro_1')
      await meio
      await e.changes('UPDATE dentro_2')
    })
    // Outro fluxo (ex.: log do runner) enquanto a transação está aberta.
    await new Promise(r => setTimeout(r, 30))
    await e.changes('INSERT INTO logs fora')
    liberar()
    await tx
    const clienteDe = (trecho: string) => execucoes.find(x => x.sql.includes(trecho))?.cliente
    expect(clienteDe('BEGIN')).toBe(clienteDe('dentro_1'))
    expect(clienteDe('dentro_2')).toBe(clienteDe('COMMIT'))
    expect(clienteDe('fora')).not.toBe(clienteDe('BEGIN'))
  })

  it('erro de conexão descarta o cliente; o seguinte vem novo do pool', async () => {
    const { pool, devolucoes } = poolFalso('quebra')
    const e = new PostgresExecutor(pool)
    await expect(e.changes('UPDATE quebra')).rejects.toThrow('Connection terminated')
    await e.changes('UPDATE ok')
    expect(devolucoes).toEqual([{ cliente: 1, destruir: true }, { cliente: 2, destruir: false }])
  })

  it('erro dentro da transação faz ROLLBACK e propaga', async () => {
    const { pool, execucoes } = poolFalso()
    const e = new PostgresExecutor(pool)
    await expect(e.transacao(async () => { await e.changes('UPDATE x'); throw new Error('falhou') })).rejects.toThrow('falhou')
    expect(execucoes.map(x => x.sql)).toEqual(['BEGIN', 'UPDATE x', 'ROLLBACK'])
  })
})
