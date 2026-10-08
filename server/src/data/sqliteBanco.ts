import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { Banco, type QueryExecutor } from './banco.ts'

const DDL =
  `CREATE TABLE IF NOT EXISTS config (
    chave TEXT PRIMARY KEY,
    valor TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    status TEXT NOT NULL DEFAULT 'pendente',
    criado_em TEXT NOT NULL DEFAULT (datetime('now')),
    total INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS job_linhas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL REFERENCES jobs(id),
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
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER,
    nivel TEXT NOT NULL DEFAULT 'info',
    msg TEXT NOT NULL,
    criado_em TEXT NOT NULL DEFAULT (datetime('now'))
  );`

class SqliteExecutor implements QueryExecutor {
  constructor(private db: Database.Database) {}

  rows<T = unknown>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    return Promise.resolve(this.db.prepare(sql).all(...(params as unknown[])) as T[])
  }

  changes(sql: string, params: readonly unknown[] = []): Promise<number> {
    const info = this.db.prepare(sql).run(...(params as unknown[]))
    return Promise.resolve(Number(info.changes))
  }

  exec(sql: string): Promise<void> {
    this.db.exec(sql)
    return Promise.resolve()
  }

  async transacao<T>(fn: () => Promise<T>): Promise<T> {
    this.db.exec('BEGIN')
    try {
      const r = await fn()
      this.db.exec('COMMIT')
      return r
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  fechar(): Promise<void> {
    this.db.close()
    return Promise.resolve()
  }
}

export class SqliteBanco extends Banco {
  private constructor(private caminho: string) {
    super()
    const dir = dirname(caminho)
    mkdirSync(dir, { recursive: true })
  }

  static abrir(caminho = 'data/app.db'): SqliteBanco {
    const banco = new SqliteBanco(caminho)
    banco.migrar()
    return banco
  }

  private novaConexao(): Database.Database {
    const db = new Database(this.caminho)
    db.pragma('journal_mode = WAL')
    return db
  }

  private migrar(): void {
    const db = this.novaConexao()
    db.exec(DDL)
    const cols = db.prepare('PRAGMA table_info(job_linhas)').all() as { name: string }[]
    if (!cols.some(c => c.name === 'base')) db.exec('ALTER TABLE job_linhas ADD COLUMN base INTEGER')
    if (!cols.some(c => c.name === 'enviadas')) db.exec('ALTER TABLE job_linhas ADD COLUMN enviadas INTEGER NOT NULL DEFAULT 0')
    if (!cols.some(c => c.name === 'base_cpf')) db.exec('ALTER TABLE job_linhas ADD COLUMN base_cpf INTEGER')
    if (!cols.some(c => c.name === 'confirmadas')) db.exec('ALTER TABLE job_linhas ADD COLUMN confirmadas INTEGER NOT NULL DEFAULT 0')
    db.close()
  }

  protected executar<R>(fn: (e: QueryExecutor) => Promise<R>): Promise<R> {
    const db = this.novaConexao()
    return fn(new SqliteExecutor(db)).finally(() => db.close())
  }
}