import { Client } from 'pg'
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
    total INTEGER NOT NULL DEFAULT 0
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
    enviadas INTEGER NOT NULL DEFAULT 0
  );
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

export class PostgresExecutor implements QueryExecutor {
  private fila: Promise<unknown> = Promise.resolve()
  private profundidade = 0

  constructor(private cliente: Client) {}

  // Serialeza toda operação num único Client: transações não sofrem interleaving.
  // Chamadas reentrantes (dentro de transacao) rodam direto, sem deadlock.
  private emFila<T>(fn: () => Promise<T>): Promise<T> {
    if (this.profundidade > 0) return fn()
    const p = this.fila.then(() => this.comContador(fn), () => this.comContador(fn))
    this.fila = p.then(() => undefined, () => undefined)
    return p
  }

  private async comContador<T>(fn: () => Promise<T>): Promise<T> {
    this.profundidade++
    try {
      return await fn()
    } finally {
      this.profundidade--
    }
  }

  rows<T = unknown>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    return this.emFila(async () => {
      const r = await this.cliente.query(traduzirMarcadores(sql), params as never[])
      return r.rows as T[]
    })
  }

  changes(sql: string, params: readonly unknown[] = []): Promise<number> {
    return this.emFila(async () => {
      const r = await this.cliente.query(traduzirMarcadores(sql), params as never[])
      return r.rowCount ?? 0
    })
  }

  exec(sql: string): Promise<void> {
    return this.emFila(async () => {
      await this.cliente.query(sql)
    })
  }

  transacao<T>(fn: () => Promise<T>): Promise<T> {
    return this.emFila(async () => {
      await this.cliente.query('BEGIN')
      try {
        const r = await fn()
        await this.cliente.query('COMMIT')
        return r
      } catch (e) {
        await this.cliente.query('ROLLBACK').catch(() => undefined)
        throw e
      }
    })
  }

  fechar(): Promise<void> {
    return this.cliente.end()
  }
}

export class PostgresBanco extends Banco {
  protected exigeBloqueioGlobal = true

  private constructor(private executor: QueryExecutor) {
    super()
  }

  static async abrir(url: string): Promise<PostgresBanco> {
    const cliente = new Client({ connectionString: url })
    await cliente.connect()
    const banco = new PostgresBanco(new PostgresExecutor(cliente))
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
}