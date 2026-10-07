import { AsyncLocalStorage } from 'node:async_hooks'
import pg from 'pg'
import type { PoolClient } from 'pg'
import { Banco, type QueryExecutor } from './banco.ts'

const DDL =
  `CREATE TABLE IF NOT EXISTS config (
    chave TEXT PRIMARY KEY,
    valor TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS jobs (
    id BIGSERIAL PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'pendente',
    criado_em TEXT NOT NULL DEFAULT (to_char(now(), 'YYYY-MM-DD HH24:MI:SS')),
    total INTEGER NOT NULL DEFAULT 0,
    lock_owner TEXT,
    lock_ate BIGINT,
    cancelar INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS job_linhas (
    id BIGSERIAL PRIMARY KEY,
    job_id BIGINT NOT NULL REFERENCES jobs(id),
    seq INTEGER NOT NULL,
    nome TEXT NOT NULL,
    cpf TEXT NOT NULL,
    telefone TEXT NOT NULL,
    email TEXT NOT NULL,
    qtd INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'pendente',
    erro TEXT,
    numeros TEXT NOT NULL DEFAULT '',
    base INTEGER,
    enviadas INTEGER NOT NULL DEFAULT 0,
    base_cpf INTEGER,
    tentativas INTEGER NOT NULL DEFAULT 0,
    confirmadas INTEGER NOT NULL DEFAULT 0
  );
  ALTER TABLE jobs ADD COLUMN IF NOT EXISTS lock_owner TEXT;
  ALTER TABLE jobs ADD COLUMN IF NOT EXISTS lock_ate BIGINT;
  ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cancelar INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE job_linhas ADD COLUMN IF NOT EXISTS base_cpf INTEGER;
  ALTER TABLE job_linhas ADD COLUMN IF NOT EXISTS tentativas INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE job_linhas ADD COLUMN IF NOT EXISTS confirmadas INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE IF NOT EXISTS logs (
    id BIGSERIAL PRIMARY KEY,
    job_id BIGINT,
    nivel TEXT NOT NULL DEFAULT 'info',
    msg TEXT NOT NULL,
    criado_em TEXT NOT NULL DEFAULT (to_char(now(), 'YYYY-MM-DD HH24:MI:SS'))
  );`

// Converte marcadores `?` do SQL compartilhado em $1, $2, ... (dialeto PostgreSQL).
export function traduzirMarcadores(sql: string): string {
  let n = 0
  return sql.replace(/\?/g, () => `$${++n}`)
}

// Pool em vez de Client único (spec §2.5): o Neon suspende o compute e derruba conexões
// ociosas; o pool descarta a conexão quebrada e abre outra na próxima consulta.
// Transações ficam presas a um cliente via AsyncLocalStorage (consultas de fora não entram nela).
const { Pool } = pg
type Pool = pg.Pool

export class PostgresExecutor implements QueryExecutor {
  private transacaoAtual = new AsyncLocalStorage<PoolClient>()

  constructor(private pool: Pool) {}

  private async comCliente<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const naTransacao = this.transacaoAtual.getStore()
    if (naTransacao) return fn(naTransacao)
    const c = await this.pool.connect()
    let falhou = false
    try {
      return await fn(c)
    } catch (e) {
      falhou = true
      throw e
    } finally {
      // Na dúvida descarta a conexão; o pool abre outra.
      c.release(falhou)
    }
  }

  rows<T = unknown>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    return this.comCliente(async c => (await c.query(traduzirMarcadores(sql), params as never[])).rows as T[])
  }

  changes(sql: string, params: readonly unknown[] = []): Promise<number> {
    return this.comCliente(async c => (await c.query(traduzirMarcadores(sql), params as never[])).rowCount ?? 0)
  }

  exec(sql: string): Promise<void> {
    return this.comCliente(async c => {
      await c.query(sql)
    })
  }

  transacao<T>(fn: () => Promise<T>): Promise<T> {
    if (this.transacaoAtual.getStore()) return fn()
    return this.comCliente(c =>
      this.transacaoAtual.run(c, async () => {
        await c.query('BEGIN')
        try {
          const r = await fn()
          await c.query('COMMIT')
          return r
        } catch (e) {
          await c.query('ROLLBACK').catch(() => undefined)
          throw e
        }
      })
    )
  }

  fechar(): Promise<void> {
    return this.pool.end()
  }
}

export function criarPool(url: string, log: (msg: string) => void = m => console.error(m)): Pool {
  const pool = new Pool({ connectionString: url, max: 5, idleTimeoutMillis: 10_000, keepAlive: true })
  // Sem estes listeners, um 'error' de conexão derruba o processo Node.
  pool.on('error', e => log(`[rifa] Postgres: conexão ociosa caiu (${e.message})`))
  pool.on('connect', c => {
    c.on('error', e => log(`[rifa] Postgres: conexão em uso caiu (${e.message})`))
  })
  return pool
}

export class PostgresBanco extends Banco {
  protected exigeBloqueioGlobal = true

  private constructor(private executor: QueryExecutor) {
    super()
  }

  static async abrir(url: string): Promise<PostgresBanco> {
    const banco = new PostgresBanco(new PostgresExecutor(criarPool(url)))
    await banco.migrar()
    return banco
  }

  static async abrirComExecutor(executor: QueryExecutor): Promise<PostgresBanco> {
    const banco = new PostgresBanco(executor)
    await banco.migrar()
    return banco
  }

  async migrar(): Promise<void> {
    await this.executor.exec(DDL)
  }

  protected executar<R>(fn: (e: QueryExecutor) => Promise<R>): Promise<R> {
    return fn(this.executor)
  }

  async fechar(): Promise<void> {
    await this.executor.fechar()
  }
}