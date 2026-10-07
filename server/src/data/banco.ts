import type { Config, LinhaJob, Pessoa, ResumoProgresso, StatusJob } from '../types.ts'

export interface ListaJob {
  id: number
  status: StatusJob
  criado_em: string
  total: number
  ok: number
  erro: number
}

export interface QueryExecutor {
  rows<T = unknown>(sql: string, params?: readonly unknown[]): Promise<T[]>
  changes(sql: string, params?: readonly unknown[]): Promise<number>
  exec(sql: string): Promise<void>
  transacao<T>(fn: () => Promise<T>): Promise<T>
  fechar(): Promise<void>
}

// Lock de execução com lease (spec 2026-10-07 §2.4). Tempos em epoch ms do relógio da aplicação.
// Um job só roda com lock válido (lock_ate >= agora) e nunca há dois locks válidos ao mesmo tempo.
export const LEASE_MS = 60_000

export const CLAIM_JOB_SQL =
  "UPDATE jobs SET status = 'rodando', lock_owner = ?, lock_ate = ?, cancelar = 0 " +
  'WHERE id = ? AND (lock_ate IS NULL OR lock_ate < ?) ' +
  'AND NOT EXISTS (SELECT 1 FROM jobs WHERE id != ? AND lock_ate IS NOT NULL AND lock_ate >= ?)'

const MSG_INTERROMPIDO = 'processo interrompido com envio sem confirmação; confira no site antes de reenviar'

// Serialeia claims concorrentes dentro da mesma transação (Postgres).
const LOCK_JOB_GLOBAL_SQL = 'SELECT pg_advisory_xact_lock(893222001)'

export function num(v: unknown): number {
  return typeof v === 'number' ? v : Number(v ?? 0)
}

function normalizarLinha(r: Record<string, unknown>): LinhaJob {
  return {
    id: num(r.id),
    job_id: num(r.job_id),
    seq: num(r.seq),
    nome: String(r.nome),
    cpf: String(r.cpf),
    telefone: String(r.telefone),
    email: String(r.email),
    qtd: num(r.qtd),
    status: r.status as LinhaJob['status'],
    erro: r.erro == null ? null : String(r.erro),
    numeros: String(r.numeros),
    base: r.base == null ? null : num(r.base),
    enviadas: num(r.enviadas),
    base_cpf: r.base_cpf == null ? null : num(r.base_cpf),
    tentativas: num(r.tentativas),
    confirmadas: num(r.confirmadas),
  }
}

export abstract class Banco {
  protected exigeBloqueioGlobal = false

  protected abstract executar<R>(fn: (e: QueryExecutor) => Promise<R>): Promise<R>

  async fechar(): Promise<void> {}

  async lerConfig(): Promise<Config | null> {
    return this.executar(async e => {
      const rows = await e.rows<{ valor: string }>("SELECT valor FROM config WHERE chave = 'login'")
      if (!rows.length) return null
      try {
        return JSON.parse(rows[0]!.valor) as Config
      } catch {
        return null
      }
    })
  }

  async gravarConfig(c: Config): Promise<void> {
    await this.executar(async e => {
      await e.changes("INSERT INTO config (chave, valor) VALUES ('login', ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor", [JSON.stringify(c)])
    })
  }

  async criarJob(linhas: Pessoa[]): Promise<number> {
    return this.executar(e =>
      e.transacao(async () => {
        const r = await e.rows<{ id: number }>('INSERT INTO jobs (status, total) VALUES (?, ?) RETURNING id', ['pendente', linhas.length])
        const jobId = num(r[0]?.id)
        for (let i = 0; i < linhas.length; i++) {
          const p = linhas[i]!
          await e.changes(
            'INSERT INTO job_linhas (job_id, seq, nome, cpf, telefone, email, qtd, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [jobId, i + 1, p.nome, p.cpf, p.telefone, p.email, p.qtd, 'pendente']
          )
        }
        return jobId
      })
    )
  }

  async linhasDoJob(jobId: number): Promise<LinhaJob[]> {
    return this.executar(async e => (await e.rows<Record<string, unknown>>('SELECT * FROM job_linhas WHERE job_id = ? ORDER BY seq', [jobId])).map(normalizarLinha))
  }

  async atualizarLinha(l: LinhaJob): Promise<void> {
    await this.executar(async e => {
      await e.changes(
        'UPDATE job_linhas SET status = ?, erro = ?, numeros = ?, base = ?, enviadas = ?, base_cpf = ?, tentativas = ?, confirmadas = ? WHERE id = ?',
        [l.status, l.erro, l.numeros, l.base, l.enviadas, l.base_cpf, l.tentativas, l.confirmadas, l.id]
      )
    })
  }

  async resumoJob(jobId: number): Promise<ResumoProgresso> {
    return this.executar(async e => {
      const rows = await e.rows<{ total: number | null; ok: number | null; erro: number | null; incerto: number | null; pendente: number | null }>(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok,
                SUM(CASE WHEN status = 'erro' THEN 1 ELSE 0 END) AS erro,
                SUM(CASE WHEN status = 'incerto' THEN 1 ELSE 0 END) AS incerto,
                SUM(CASE WHEN status IN ('pendente','cadastrando') THEN 1 ELSE 0 END) AS pendente
         FROM job_linhas WHERE job_id = ?`,
        [jobId]
      )
      const jobs = await e.rows<{ status: StatusJob }>('SELECT status FROM jobs WHERE id = ?', [jobId])
      const r = rows[0]
      return {
        total: num(r?.total ?? 0),
        ok: num(r?.ok ?? 0),
        erro: num(r?.erro ?? 0),
        incerto: num(r?.incerto ?? 0),
        pendente: num(r?.pendente ?? 0),
        ativo: jobs[0]?.status === 'rodando',
      }
    })
  }

  async atualizarStatusJob(jobId: number, status: StatusJob): Promise<void> {
    await this.executar(async e => {
      await e.changes('UPDATE jobs SET status = ? WHERE id = ?', [status, jobId])
    })
  }

  // Claim atômico com lease. SQLite é seguro por conexão de escrita única;
  // Postgres serializa com advisory lock dentro da transação (exigeBloqueioGlobal).
  async tentarIniciarJob(jobId: number, dono: string, agora = Date.now()): Promise<boolean> {
    return this.executar(e =>
      e.transacao(async () => {
        if (this.exigeBloqueioGlobal) {
          await e.rows<unknown[]>(LOCK_JOB_GLOBAL_SQL)
        }
        await this.reconciliarCom(e, agora)
        return (await e.changes(CLAIM_JOB_SQL, [dono, agora + LEASE_MS, jobId, agora, jobId, agora])) > 0
      })
    )
  }

  // Renova só se o lock ainda é deste dono e não expirou. Devolve se houve pedido de cancelamento.
  async renovarLock(jobId: number, dono: string, agora = Date.now()): Promise<{ ok: boolean; cancelar: boolean }> {
    return this.executar(async e => {
      const ok = (await e.changes('UPDATE jobs SET lock_ate = ? WHERE id = ? AND lock_owner = ? AND lock_ate >= ?', [agora + LEASE_MS, jobId, dono, agora])) > 0
      const r = await e.rows<{ cancelar: unknown }>('SELECT cancelar FROM jobs WHERE id = ?', [jobId])
      return { ok, cancelar: num(r[0]?.cancelar) === 1 }
    })
  }

  async liberarLock(jobId: number, dono: string, status: StatusJob): Promise<void> {
    await this.executar(async e => {
      await e.changes('UPDATE jobs SET status = ?, lock_owner = NULL, lock_ate = NULL, cancelar = 0 WHERE id = ? AND lock_owner = ?', [status, jobId, dono])
    })
  }

  async lockValido(jobId: number, agora = Date.now()): Promise<boolean> {
    return this.executar(async e => (await e.rows('SELECT 1 FROM jobs WHERE id = ? AND lock_ate IS NOT NULL AND lock_ate >= ?', [jobId, agora])).length > 0)
  }

  async algumLockValido(agora = Date.now()): Promise<boolean> {
    return this.executar(async e => (await e.rows('SELECT 1 FROM jobs WHERE lock_ate IS NOT NULL AND lock_ate >= ?', [agora])).length > 0)
  }

  // Só sinaliza: o status muda quando o runner realmente sai (liberarLock).
  async cancelarJob(jobId: number, agora = Date.now()): Promise<boolean> {
    return this.executar(async e => (await e.changes('UPDATE jobs SET cancelar = 1 WHERE id = ? AND lock_ate IS NOT NULL AND lock_ate >= ?', [jobId, agora])) > 0)
  }

  async linhaPorId(id: number): Promise<LinhaJob | null> {
    return this.executar(async e => {
      const r = await e.rows<Record<string, unknown>>('SELECT * FROM job_linhas WHERE id = ?', [id])
      return r[0] ? normalizarLinha(r[0]) : null
    })
  }

  async reprocessarErros(jobId: number): Promise<void> {
    await this.executar(async e => {
      await e.changes("UPDATE job_linhas SET status = 'pendente', erro = NULL WHERE job_id = ? AND status = 'erro'", [jobId])
    })
  }

  async resetarJob(jobId: number): Promise<void> {
    await this.executar(async e => {
      await e.changes("UPDATE job_linhas SET status = 'pendente', erro = NULL WHERE job_id = ?", [jobId])
    })
  }

  async listarJobs(): Promise<ListaJob[]> {
    return this.executar(async e => {
      const rows = await e.rows<Record<string, unknown>>(
        `SELECT j.id, j.status, j.criado_em, j.total,
                COALESCE(SUM(CASE WHEN l.status='ok' THEN 1 ELSE 0 END),0) AS ok,
                COALESCE(SUM(CASE WHEN l.status='erro' THEN 1 ELSE 0 END),0) AS erro
         FROM jobs j LEFT JOIN job_linhas l ON l.job_id = j.id
         GROUP BY j.id ORDER BY j.id DESC`
      )
      return rows.map(r => ({
        id: num(r.id),
        status: r.status as StatusJob,
        criado_em: String(r.criado_em),
        total: num(r.total),
        ok: num(r.ok),
        erro: num(r.erro),
      }))
    })
  }

  async registrarLog(msg: string, nivel = 'info', jobId: number | null = null): Promise<void> {
    await this.executar(async e => {
      await e.changes('INSERT INTO logs (job_id, nivel, msg) VALUES (?, ?, ?)', [jobId, nivel, msg])
    })
  }

  async logs(jobId: number | null = null, limite = 200): Promise<string[]> {
    return this.executar(async e => {
      const rows =
        jobId === null || jobId === 0
          ? await e.rows<{ nivel: string; msg: string; criado_em: string }>('SELECT nivel, msg, criado_em FROM logs ORDER BY id DESC LIMIT ?', [limite])
          : await e.rows<{ nivel: string; msg: string; criado_em: string }>('SELECT nivel, msg, criado_em FROM logs WHERE job_id = ? ORDER BY id DESC LIMIT ?', [jobId, limite])
      return rows.map(r => `[${r.nivel}] ${r.msg} (${r.criado_em})`)
    })
  }

  // Locks expiram sozinhos; nada aqui mexe em job com lock válido (outra instância rodando).
  // Linha cadastrando de lock expirado: incerto se há envio sem confirmação, senão pendente.
  async reconciliarExpirados(agora = Date.now()): Promise<void> {
    await this.executar(e => e.transacao(() => this.reconciliarCom(e, agora)))
  }

  private async reconciliarCom(e: QueryExecutor, agora: number): Promise<void> {
    const semLock = 'SELECT id FROM jobs WHERE lock_ate IS NULL OR lock_ate < ?'
    await e.changes(
      `UPDATE job_linhas SET status = 'incerto', erro = ? WHERE status = 'cadastrando' AND tentativas > confirmadas AND job_id IN (${semLock})`,
      [MSG_INTERROMPIDO, agora]
    )
    await e.changes(`UPDATE job_linhas SET status = 'pendente' WHERE status = 'cadastrando' AND job_id IN (${semLock})`, [agora])
    await e.changes(
      "UPDATE jobs SET status = 'pendente', lock_owner = NULL, lock_ate = NULL, cancelar = 0 WHERE status = 'rodando' AND (lock_ate IS NULL OR lock_ate < ?)",
      [agora]
    )
  }
}