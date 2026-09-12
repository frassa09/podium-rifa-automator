import { describe, expect, it, vi } from 'vitest'
import { Automator } from '../src/engine/automator.ts'
import type { LinhaJob, Pessoa } from '../src/types.ts'

const linha = (id: number, qtd = 1, status: LinhaJob['status'] = 'pendente'): LinhaJob => ({
  id, job_id: 1, seq: id, nome: 'Maria', cpf: '86730169087',
  telefone: '11987654321', email: 'm@x.com', qtd, status, erro: null, numeros: '',
})

function ultimosStatus(progress: LinhaJob[]): Map<number, string> {
  const m = new Map<number, string>()
  for (const l of progress) m.set(l.id, l.status)
  return m
}

describe('Automator', () => {
  it('processa todas as linhas na ordem', async () => {
    const submetidas: Pessoa[] = []
    const deps = {
      getSessao: async () => ({}) as never,
      submeterLinha: async (_s: unknown, p: Pessoa) => { submetidas.push(p) },
      lerMaiorNumero: async () => 0,
      log: () => {},
    }
    const a = new Automator(deps)
    const linhas = [linha(1), linha(2), linha(3)]
    const progress: LinhaJob[] = []
    await a.start(linhas, l => progress.push(l))
    expect(submetidas).toHaveLength(3)
    expect([...ultimosStatus(progress).values()]).toEqual(['ok', 'ok', 'ok'])
  })

  it('replica submissões quando qtd > 1', async () => {
    let chamadas = 0
    const deps = {
      getSessao: async () => ({}) as never,
      submeterLinha: async () => { chamadas++ },
      lerMaiorNumero: async () => 0,
      log: () => {},
    }
    const a = new Automator(deps)
    await a.start([linha(1, 3)], () => {})
    expect(chamadas).toBe(3)
  })

  it('marca erro após 2 tentativas com motivos', async () => {
    const deps = {
      getSessao: async () => ({}) as never,
      submeterLinha: async () => { throw new Error('rede') },
      lerMaiorNumero: async () => 0,
      log: () => {},
    }
    const a = new Automator(deps)
    const progress: LinhaJob[] = []
    await a.start([linha(1)], l => progress.push(l))
    expect([...ultimosStatus(progress).values()]).toEqual(['erro'])
    expect(progress[progress.length - 1]?.erro).toBeTruthy()
  })

  it('não reprocessa linha já ok (resume)', async () => {
    const submetidas: Pessoa[] = []
    const deps = {
      getSessao: async () => ({}) as never,
      submeterLinha: async (_s: unknown, p: Pessoa) => { submetidas.push(p) },
      lerMaiorNumero: async () => 0,
      log: () => {},
    }
    const a = new Automator(deps)
    await a.start([linha(1, 1, 'ok'), linha(2)], () => {})
    expect(submetidas).toHaveLength(1)
    expect(submetidas[0]?.cpf).toBe('86730169087')
  })

  it('para quando deveParar retorna true e deixa linha pendente', async () => {
    const deps = {
      getSessao: async () => ({}) as never,
      submeterLinha: async () => {},
      lerMaiorNumero: async () => 0,
      log: () => {},
      deveParar: () => true,
    }
    const a = new Automator(deps)
    const progress: LinhaJob[] = []
    await a.start([linha(1), linha(2)], l => progress.push(l))
    expect([...ultimosStatus(progress).values()]).toEqual(['pendente'])
    expect(progress[progress.length - 1]?.erro).toBeNull()
  })

  it('emite cadastrando antes do estado final', async () => {
    const deps = {
      getSessao: async () => ({}) as never,
      submeterLinha: async () => {},
      lerMaiorNumero: async () => 0,
      log: () => {},
    }
    const a = new Automator(deps)
    const statuses: string[] = []
    await a.start([linha(1)], l => statuses.push(l.status))
    expect(statuses).toContain('cadastrando')
    expect(statuses[statuses.length - 1]).toBe('ok')
  })

  it('cancelamento durante submissão deixa linha pendente (não re-submete)', async () => {
    let chamadas = 0
    let parar = false
    const deps = {
      getSessao: async () => ({}) as never,
      submeterLinha: async () => { chamadas++; if (chamadas === 1) parar = true },
      lerMaiorNumero: async () => 1000,
      log: () => {},
      deveParar: () => parar,
    }
    const a = new Automator(deps)
    const progress: LinhaJob[] = []
    await a.start([linha(1, 2)], l => progress.push(l))
    expect(chamadas).toBe(1)
    expect(progress[0]?.status).toBe('pendente')
  })

  it('retomada não duplica linhas já ok', async () => {
    const sub = new Set<number>()
    const deps = {
      getSessao: async () => ({}) as never,
      submeterLinha: async () => sub.add(1),
      lerMaiorNumero: async () => 0,
      log: () => {},
    }
    const a = new Automator(deps)
    const linhas = [linha(1, 1, 'ok')]
    await a.start(linhas, () => {})
    expect(sub.size).toBe(0)
  })
})