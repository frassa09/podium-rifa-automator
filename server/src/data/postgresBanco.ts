import pg from 'pg'
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
    enviadas INTEGER NOT NULL DEFAULT 0,
    base_cpf INTEGER,
    confirmadas INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS logs (
    id BIGSERIAL PRIMARY KEY,
    job_id BIGINT,
    nivel TEXT NOT NULL DEFAULT 'info',
    msg TEXT NOT NULL,
    criado_em TEXT NOT NULL DEFAULT (to_char(now(), 'YYYY-MM-DD HH24:MI:SS'))
  );
  ALTER TABLE job_linhas ADD COLUMN IF NOT EXISTS base_cpf INTEGER;
  ALTER TABLE job_linhas ADD COLUMN IF NOT EXISTS confirmadas INTEGER NOT NULL DEFAULT 0;`

// Converte marcadores `?` do SQL compartilhado em $1, $2, ... (dialeto PostgreSQL).
export function traduzirMarcadores(sql: string): string {
  let n = 0
  return sql.replace(/\?/g, () => `$${++n}`)
}

export interface ConexaoPg {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>
  release(destruir?: boolean): void
}

export interface PoolPg {
  connect(): Promise<ConexaoPg>
  end(): Promise<void>
}

const espera = (ms: number) => new Promise(r => setTimeout(r, ms))

// Usa um Pool (não um Client fixo): o Neon free suspende o compute quando ocioso e
// derruba conexões; o pool descarta a conexão morta e abre outra na próxima operação.
export class PostgresExecutor implements QueryExecutor {
  private fila: Promise<unknown> = Promise.resolve()
  private profundidade = 0
  private atual: ConexaoPg | null = null

  constructor(
    private pool: PoolPg,
    private tentativasConexao = 3,
    private esperaMs = 1_000,
  ) {}

  // Serializa toda operação numa conexão por vez: transações não sofrem interleaving.
  // Chamadas reentrantes (dentro de transacao) reutilizam a mesma conexão, sem deadlock.
  private emFila<T>(fn: (c: ConexaoPg) => Promise<T>): Promise<T> {
    if (this.profundidade > 0 && this.atual) return fn(this.atual)
    const p = this.fila.then(() => this.comConexao(fn), () => this.comConexao(fn))
    this.fila = p.then(() => undefined, () => undefined)
    return p
  }

  // Só a obtenção da conexão é re-tentada (cold start do Neon); a query nunca é
  // repetida, pois não dá para saber se ela chegou a ser aplicada.
  private async conectar(): Promise<ConexaoPg> {
    for (let i = 1; ; i++) {
      try {
        return await this.pool.connect()
      } catch (e) {
        if (i >= this.tentativasConexao) throw e
        await espera(this.esperaMs * i)
      }
    }
  }

  private async comConexao<T>(fn: (c: ConexaoPg) => Promise<T>): Promise<T> {
    const c = await this.conectar()
    this.atual = c
    this.profundidade++
    let falhou = false
    try {
      return await fn(c)
    } catch (e) {
      falhou = true
      throw e
    } finally {
      this.profundidade--
      this.atual = null
      // Conexão que deu erro é descartada: pode estar quebrada.
      c.release(falhou)
    }
  }

  rows<T = unknown>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    return this.emFila(async c => {
      const r = await c.query(traduzirMarcadores(sql), params as unknown[])
      return r.rows as T[]
    })
  }

  changes(sql: string, params: readonly unknown[] = []): Promise<number> {
    return this.emFila(async c => {
      const r = await c.query(traduzirMarcadores(sql), params as unknown[])
      return r.rowCount ?? 0
    })
  }

  exec(sql: string): Promise<void> {
    return this.emFila(async c => {
      await c.query(sql)
    })
  }

  transacao<T>(fn: () => Promise<T>): Promise<T> {
    return this.emFila(async c => {
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
  }

  fechar(): Promise<void> {
    return this.pool.end()
  }
}

export class PostgresBanco extends Banco {
  protected exigeBloqueioGlobal = true

  private constructor(private executor: QueryExecutor) {
    super()
  }

  static async abrir(url: string): Promise<PostgresBanco> {
    const pool = new pg.Pool({
      connectionString: url,
      max: 2,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 15_000,
    })
    // Sem este handler, uma conexão ociosa derrubada pelo Neon emite 'error' e mata o processo.
    pool.on('error', e => console.error('[rifa] Conexão Postgres ociosa caiu (será reaberta):', e.message))
    const banco = new PostgresBanco(new PostgresExecutor(pool as unknown as PoolPg))
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