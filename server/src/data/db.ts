import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Config, LinhaJob, Pessoa, ResumoProgresso, StatusJob } from '../types.ts'

export class Banco {
  private caminho: string
  private constructor(caminho: string) {
    this.caminho = caminho
    const dir = dirname(caminho)
    mkdirSync(dir, { recursive: true })
    this.migrar()
  }

  static abrir(caminho = 'data/app.db'): Banco {
    return new Banco(caminho)
  }

  private novaConexao(): Database.Database {
    const db = new Database(this.caminho)
    db.pragma('journal_mode = WAL')
    return db
  }

  private migrar(): void {
    const db = this.novaConexao()
    db.exec(`
      CREATE TABLE IF NOT EXISTS config (
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
        numeros TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id INTEGER,
        nivel TEXT NOT NULL DEFAULT 'info',
        msg TEXT NOT NULL,
        criado_em TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `)
    db.close()
  }

  lerConfig(): Config | null {
    const db = this.novaConexao()
    try {
      const row = db.prepare("SELECT valor FROM config WHERE chave = 'login'").get() as
        | { valor: string }
        | undefined
      if (!row) return null
      try {
        return JSON.parse(row.valor) as Config
      } catch {
        return null
      }
    } finally {
      db.close()
    }
  }

  gravarConfig(c: Config): void {
    const db = this.novaConexao()
    try {
      db.prepare("INSERT INTO config (chave, valor) VALUES ('login', ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor").run(JSON.stringify(c))
    } finally {
      db.close()
    }
  }

  criarJob(linhas: Pessoa[]): number {
    const db = this.novaConexao()
    try {
      const tx = db.transaction((ls: Pessoa[]) => {
        const info = db
          .prepare('INSERT INTO jobs (status, total) VALUES (?, ?)')
          .run('pendente', ls.length)
        const jobId = Number(info.lastInsertRowid)
        const stmt = db.prepare(
          'INSERT INTO job_linhas (job_id, seq, nome, cpf, telefone, email, qtd, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        )
        ls.forEach((p, i) =>
          stmt.run(jobId, i + 1, p.nome, p.cpf, p.telefone, p.email, p.qtd, 'pendente')
        )
        return jobId
      })
      return tx(linhas) as number
    } finally {
      db.close()
    }
  }

  linhasDoJob(jobId: number): LinhaJob[] {
    const db = this.novaConexao()
    try {
      return db
        .prepare('SELECT * FROM job_linhas WHERE job_id = ? ORDER BY seq')
        .all(jobId) as unknown as LinhaJob[]
    } finally {
      db.close()
    }
  }

  atualizarLinha(l: LinhaJob): void {
    const db = this.novaConexao()
    try {
      db.prepare('UPDATE job_linhas SET status = ?, erro = ?, numeros = ? WHERE id = ?').run(l.status, l.erro, l.numeros, l.id)
    } finally {
      db.close()
    }
  }

  resumoJob(jobId: number): ResumoProgresso {
    const db = this.novaConexao()
    try {
      const row = db
        .prepare(
          `SELECT
             COUNT(*) AS total,
             SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok,
             SUM(CASE WHEN status = 'erro' THEN 1 ELSE 0 END) AS erro,
             SUM(CASE WHEN status IN ('pendente','cadastrando') THEN 1 ELSE 0 END) AS pendente
           FROM job_linhas WHERE job_id = ?`
        )
        .get(jobId) as { total: number; ok: number | null; erro: number | null; pendente: number | null }
      const j = db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId) as
        | { status: StatusJob }
        | undefined
      return {
        total: row.total,
        ok: row.ok ?? 0,
        erro: row.erro ?? 0,
        pendente: row.pendente ?? 0,
        ativo: j?.status === 'rodando',
      }
    } finally {
      db.close()
    }
  }

  atualizarStatusJob(jobId: number, status: StatusJob): void {
    const db = this.novaConexao()
    try {
      db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run(status, jobId)
    } finally {
      db.close()
    }
  }

  reprocessarErros(jobId: number): void {
    const db = this.novaConexao()
    try {
      db.prepare("UPDATE job_linhas SET status = 'pendente', erro = NULL WHERE job_id = ? AND status = 'erro'").run(jobId)
    } finally {
      db.close()
    }
  }

  resetarJob(jobId: number): void {
    const db = this.novaConexao()
    try {
      db.prepare("UPDATE job_linhas SET status = 'pendente', erro = NULL WHERE job_id = ?").run(jobId)
    } finally {
      db.close()
    }
  }

  listarJobs(): { id: number; status: StatusJob; criado_em: string; total: number; ok: number; erro: number }[] {
    const db = this.novaConexao()
    try {
      return db
        .prepare(
          `SELECT j.id, j.status, j.criado_em, j.total,
                  COALESCE(SUM(CASE WHEN l.status='ok' THEN 1 ELSE 0 END),0) AS ok,
                  COALESCE(SUM(CASE WHEN l.status='erro' THEN 1 ELSE 0 END),0) AS erro
           FROM jobs j LEFT JOIN job_linhas l ON l.job_id = j.id
           GROUP BY j.id ORDER BY j.id DESC`
        )
        .all() as unknown as { id: number; status: StatusJob; criado_em: string; total: number; ok: number; erro: number }[]
    } finally {
      db.close()
    }
  }

  registrarLog(msg: string, nivel = 'info', jobId: number | null = null): void {
    const db = this.novaConexao()
    try {
      db.prepare('INSERT INTO logs (job_id, nivel, msg) VALUES (?, ?, ?)').run(jobId, nivel, msg)
    } finally {
      db.close()
    }
  }

  logs(jobId: number | null = null, limite = 200): string[] {
    const db = this.novaConexao()
    try {
      const rows = jobId === null || jobId === 0
        ? db.prepare('SELECT nivel, msg, criado_em FROM logs ORDER BY id DESC LIMIT ?').all(limite)
        : db.prepare('SELECT nivel, msg, criado_em FROM logs WHERE job_id = ? ORDER BY id DESC LIMIT ?').all(jobId, limite)
      return (rows as { nivel: string; msg: string; criado_em: string }[]).map(
        r => `[${r.nivel}] ${r.msg} (${r.criado_em})`
      )
    } finally {
      db.close()
    }
  }
}