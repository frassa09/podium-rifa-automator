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

export const CLAIM_JOB_SQL =
  "UPDATE jobs SET status = 'rodando' WHERE id = ? AND status != 'rodando' AND NOT EXISTS (SELECT 1 FROM jobs WHERE status = 'rodando' AND id != ?)"

// Serialeia claims concorrentes dentro da mesma transação (Postgres).
const LOCK_JOB_GLOBAL_SQL = 'SELECT pg_advisory_xact_lock(893222001)'

// Linha criada/rodada pela versão antiga (que media pelo Nº e chegou a enviar ou medir):
// o estado dela não é confiável para a nova contagem por CPF.
export const SQL_LINHA_LEGADA = '(base_cpf IS NULL AND (base IS NOT NULL OR enviadas > 0))'

export function linhaLegada(l: Pick<LinhaJob, 'base_cpf' | 'base' | 'enviadas'>): boolean {
  return l.base_cpf === null && (l.base !== null || l.enviadas > 0)
}

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
    base_cpf: r.base_cpf == null ? null : num(r.base_cpf),
    enviadas: num(r.enviadas),
    confirmadas: num(r.confirmadas),
  }
}

export abstract class Banco {
  protected exigeBloqueioGlobal = false

  protected abstract executar<R>(fn: (e: QueryExecutor) => Promise<R>): Promise<R>

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

  // Linhas não concluídas de outros jobs com os mesmos CPFs: criar outro job para elas
  // pode duplicar rifas.
  async linhasEmAbertoDosCpfs(cpfs: string[]): Promise<{ job_id: number; nome: string; cpf: string }[]> {
    if (!cpfs.length) return []
    const marcadores = cpfs.map(() => '?').join(', ')
    return this.executar(async e =>
      (await e.rows<Record<string, unknown>>(
        `SELECT job_id, nome, cpf FROM job_linhas WHERE status != 'ok' AND cpf IN (${marcadores}) ORDER BY job_id, seq`,
        cpfs
      )).map(r => ({ job_id: num(r.job_id), nome: String(r.nome), cpf: String(r.cpf) }))
    )
  }

  async linhasDoJob(jobId: number): Promise<LinhaJob[]> {
    return this.executar(async e => (await e.rows<Record<string, unknown>>('SELECT * FROM job_linhas WHERE job_id = ? ORDER BY seq', [jobId])).map(normalizarLinha))
  }

  async atualizarLinha(l: LinhaJob): Promise<void> {
    await this.executar(async e => {
      // `base` (legado) não é regravado. `enviadas` nunca diminui por aqui: só o reprocessamento
      // explícito (usuário conferiu o site) pode baixá-lo.
      const n = await e.changes(
        'UPDATE job_linhas SET status = ?, erro = ?, numeros = ?, base_cpf = ?, enviadas = ?, confirmadas = ? WHERE id = ? AND enviadas <= ?',
        [l.status, l.erro, l.numeros, l.base_cpf, l.enviadas, l.confirmadas, l.id, l.enviadas]
      )
      if (n === 0) throw new Error(`Linha #${l.id}: gravação recusada (registro de envios no banco é maior que o informado)`)
    })
  }

  async resumoJob(jobId: number): Promise<ResumoProgresso> {
    return this.executar(async e => {
      const rows = await e.rows<{ total: number | null; ok: number | null; erro: number | null; pendente: number | null }>(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok,
                SUM(CASE WHEN status = 'erro' THEN 1 ELSE 0 END) AS erro,
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

  // Claim atômico do job único. SQLite é seguro por conexão de escrita única;
  // Postgres serializa com advisory lock dentro da transação (exigeBloqueioGlobal).
  async tentarIniciarJob(jobId: number): Promise<boolean> {
    return this.executar(e =>
      e.transacao(async () => {
        if (this.exigeBloqueioGlobal) {
          await e.rows<unknown[]>(LOCK_JOB_GLOBAL_SQL)
        }
        return (await e.changes(CLAIM_JOB_SQL, [jobId, jobId])) > 0
      })
    )
  }

  async cancelarJob(jobId: number): Promise<boolean> {
    return this.executar(async e => (await e.changes("UPDATE jobs SET status = 'pendente' WHERE id = ? AND status = 'rodando'", [jobId])) > 0)
  }

  // Ação explícita do usuário depois de conferir o site: libera reenvio só do que não foi
  // confirmado (enviadas volta a confirmadas). Na retomada o motor recontará no site antes de enviar.
  // Linhas da versão antiga (medição pelo Nº) nunca são liberadas.
  async reprocessarErros(jobId: number): Promise<number> {
    return this.executar(async e =>
      e.changes(
        `UPDATE job_linhas SET status = 'pendente', erro = NULL, enviadas = confirmadas
         WHERE job_id = ? AND status = 'erro' AND NOT ${SQL_LINHA_LEGADA}`,
        [jobId]
      )
    )
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

  async reconciliarBoot(): Promise<void> {
    await this.executar(async e => {
      await e.changes("UPDATE jobs SET status = 'pendente' WHERE status = 'rodando'")
      await e.changes("UPDATE job_linhas SET status = 'pendente' WHERE status = 'cadastrando'")
    })
  }
}