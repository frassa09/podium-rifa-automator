import { describe, expect, it } from 'vitest'
import { Automator, type AutomatorDeps } from '../src/engine/automator.ts'
import type { LinhaJob, Pessoa } from '../src/types.ts'

const linha = (id: number, qtd = 1, status: LinhaJob['status'] = 'pendente', extra: Partial<LinhaJob> = {}): LinhaJob => ({
  id, job_id: 1, seq: id, nome: 'Maria', cpf: '86730169087',
  telefone: '11987654321', email: 'm@x.com', qtd, status, erro: null, numeros: '',
  base: null, enviadas: 0, ...extra,
})

function siteMock() {
  let siteN = 0
  const submetidas: Pessoa[] = []
  const deps: AutomatorDeps = {
    getSessao: async () => ({}) as never,
    submeterLinha: async (_s: unknown, p: Pessoa) => { submetidas.push(p); siteN += p.qtd },
    lerMaiorNumero: async () => siteN,
    log: () => {},
  }
  return { deps, get siteN() { return siteN }, submetidas }
}

function ultimosStatus(progress: LinhaJob[]): Map<number, string> {
  const m = new Map<number, string>()
  for (const l of progress) m.set(l.id, l.status)
  return m
}

describe('Automator', () => {
  it('processa todas as linhas na ordem', async () => {
    const { deps, submetidas } = siteMock()
    const a = new Automator(deps)
    const linhas = [linha(1), linha(2), linha(3)]
    const progress: LinhaJob[] = []
    await a.start(linhas, l => progress.push(l))
    expect(submetidas).toHaveLength(3)
    expect([...ultimosStatus(progress).values()]).toEqual(['ok', 'ok', 'ok'])
  })

  it('replica submissões quando qtd > 1', async () => {
    const { deps, submetidas } = siteMock()
    const a = new Automator(deps)
    await a.start([linha(1, 3)], () => {})
    expect(submetidas).toHaveLength(3)
  })

  it('marca erro após 2 tentativas com motivos', async () => {
    const deps: AutomatorDeps = {
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
    const { deps, submetidas } = siteMock()
    const a = new Automator(deps)
    await a.start([linha(1, 1, 'ok'), linha(2)], () => {})
    expect(submetidas).toHaveLength(1)
    expect(submetidas[0]?.cpf).toBe('86730169087')
  })

  it('para quando deveParar retorna true e deixa linha pendente', async () => {
    const { deps } = siteMock()
    deps.deveParar = () => true
    const a = new Automator(deps)
    const progress: LinhaJob[] = []
    await a.start([linha(1), linha(2)], l => progress.push(l))
    expect([...ultimosStatus(progress).values()]).toEqual(['pendente'])
    expect(progress[progress.length - 1]?.erro).toBeNull()
  })

  it('emite cadastrando antes do estado final', async () => {
    const { deps } = siteMock()
    const a = new Automator(deps)
    const statuses: string[] = []
    await a.start([linha(1)], l => statuses.push(l.status))
    expect(statuses).toContain('cadastrando')
    expect(statuses[statuses.length - 1]).toBe('ok')
  })

  it('cancelamento durante submissão deixa linha pendente (não re-submete)', async () => {
    let chamadas = 0
    let parar = false
    const { deps } = siteMock()
    const sub = deps.submeterLinha
    deps.submeterLinha = async (s, p) => { chamadas++; if (chamadas === 1) parar = true; await sub(s, p) }
    deps.deveParar = () => parar
    const a = new Automator(deps)
    const progress: LinhaJob[] = []
    await a.start([linha(1, 2)], l => progress.push(l))
    expect(chamadas).toBe(1)
    expect(progress[0]?.status).toBe('pendente')
  })

  it('retomada não duplica linhas já ok', async () => {
    const { deps, submetidas } = siteMock()
    const a = new Automator(deps)
    const linhas = [linha(1, 1, 'ok')]
    await a.start(linhas, () => {})
    expect(submetidas).toHaveLength(0)
  })

  it('não marca ok sem verificação quando a página não retorna números', async () => {
    const deps: AutomatorDeps = {
      getSessao: async () => ({}) as never,
      submeterLinha: async () => {},
      lerMaiorNumero: async () => 0,
      log: () => {},
    }
    const a = new Automator(deps)
    const progress: LinhaJob[] = []
    await a.start([linha(1)], l => progress.push(l))
    expect(progress[progress.length - 1]?.status).toBe('erro')
  })

  it('cancelar e retomar linha parcial não re-submete o que já entrou', async () => {
    let siteN = 101
    const submetidas: Pessoa[] = []
    const deps: AutomatorDeps = {
      getSessao: async () => ({}) as never,
      submeterLinha: async (_s: unknown, p: Pessoa) => { submetidas.push(p); siteN += 1 },
      lerMaiorNumero: async () => siteN,
      log: () => {},
    }
    const a = new Automator(deps)
    const l = linha(1, 2, 'pendente', { base: 100, enviadas: 1 })
    await a.start([l], () => {})
    expect(submetidas).toHaveLength(1)
    expect(l.status).toBe('ok')
    expect(l.enviadas).toBe(2)
  })

  it('renova sessão a cada tentativa quando a sessão expira', async () => {
    let renovada = false
    let siteN = 0
    const deps: AutomatorDeps = {
      getSessao: async () => ({ id: renovada ? 2 : 1 }),
      submeterLinha: async s => {
        if ((s as { id: number }).id === 1) {
          renovada = true
          throw new Error('sessão expirada')
        }
        siteN += 1
      },
      lerMaiorNumero: async () => siteN,
      log: () => {},
    }
    const a = new Automator(deps)
    const progress: LinhaJob[] = []
    await a.start([linha(1)], l => progress.push(l))
    expect(progress[progress.length - 1]?.status).toBe('ok')
    expect(siteN).toBe(1)
  })

  it('não duplica quando a submissão foi processada mas a resposta lança erro', async () => {
    let siteN = 500
    const submetidas: Pessoa[] = []
    const deps: AutomatorDeps = {
      getSessao: async () => ({}) as never,
      submeterLinha: async (_s: unknown, p: Pessoa) => {
        submetidas.push(p)
        siteN += 1
        throw new Error('rede caiu após enviar')
      },
      lerMaiorNumero: async () => siteN,
      log: () => {},
    }
    const a = new Automator(deps)
    const l = linha(1, 1, 'pendente', { base: 500 })
    const progress: LinhaJob[] = []
    await a.start([l], x => progress.push(x))
    expect(submetidas).toHaveLength(1)
    expect(progress[progress.length - 1]?.status).toBe('ok')
  })

  it('não re-submete quando a criação não pode ser confirmada (parada de segurança)', async () => {
    let siteN = 100
    let leituras = 0
    const submetidas: Pessoa[] = []
    const deps: AutomatorDeps = {
      getSessao: async () => ({}) as never,
      submeterLinha: async (_s: unknown, p: Pessoa) => {
        submetidas.push(p)
        siteN += 1
        throw new Error('sem diagnóstico de rede')
      },
      lerMaiorNumero: async () => {
        leituras++
        if (leituras > 1) throw new Error('leitura indisponível')
        return siteN
      },
      log: () => {},
    }
    const a = new Automator(deps)
    const l = linha(1, 1, 'pendente', { base: 100 })
    await expect(a.start([l])).rejects.toThrow()
    expect(submetidas).toHaveLength(1)
    expect(l.status).toBe('erro')
    expect(l.erro).toContain('não confirmada')
  })

  it('não duplica em lote quando uma submissão do meio falha após criar', async () => {
    let siteN = 0
    let chamadas = 0
    const submetidas: Pessoa[] = []
    const deps: AutomatorDeps = {
      getSessao: async () => ({}) as never,
      submeterLinha: async (_s: unknown, p: Pessoa) => {
        submetidas.push(p)
        siteN += 1
        chamadas++
        if (chamadas === 2) throw new Error('falha na 2ª submissão')
      },
      lerMaiorNumero: async () => siteN,
      log: () => {},
    }
    const a = new Automator(deps)
    const l = linha(1, 2)
    await a.start([l], () => {})
    expect(submetidas).toHaveLength(2)
    expect(l.status).toBe('ok')
    expect(siteN).toBe(2)
  })

  it('não envia nada quando o Nº do site já alcançou o alvo da linha', async () => {
    const submetidas: Pessoa[] = []
    const deps: AutomatorDeps = {
      getSessao: async () => ({}) as never,
      submeterLinha: async (_s: unknown, p: Pessoa) => { submetidas.push(p) },
      lerMaiorNumero: async () => 102,
      log: () => {},
    }
    const a = new Automator(deps)
    const l = linha(1, 2, 'pendente', { base: 100, enviadas: 0 })
    await a.start([l], () => {})
    expect(submetidas).toHaveLength(0)
    expect(l.status).toBe('ok')
    expect(l.enviadas).toBe(2)
  })
})