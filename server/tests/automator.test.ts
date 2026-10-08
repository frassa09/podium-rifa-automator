import { describe, expect, it } from 'vitest'
import { Automator, JobAbortado, type AutomatorDeps } from '../src/engine/automator.ts'
import type { RifaSite } from '../src/podium/session.ts'
import type { LinhaJob, Pessoa } from '../src/types.ts'

const CPF_A = '86730169087'
const CPF_B = '11144477735'

function linha(id: number, cpf: string, qtd = 1, extra: Partial<LinhaJob> = {}): LinhaJob {
  return {
    id, job_id: 1, seq: id, nome: `Pessoa ${id}`, cpf, telefone: '11987654321', email: 'a@b.com', qtd,
    status: 'pendente', erro: null, numeros: '', base: null, base_cpf: null, enviadas: 0, confirmadas: 0,
    ...extra,
  }
}

// Site em memória: `aoEnviar` decide o que cada POST faz; a leitura pode ser sabotada.
function siteMemoria(iniciais: RifaSite[] = []) {
  let numero = 1003
  const s = {
    rifas: [...iniciais],
    posts: [] as Pessoa[],
    aoEnviar: (p: Pessoa): 'cria' | 'ignora' | 'cria-e-lanca' | 'lanca' => (void p, 'cria'),
    leitura: (r: RifaSite[]): RifaSite[] => r,
    salvos: [] as LinhaJob[],
    logs: [] as string[],
    parar: false,
    lerFalha: 0, // próximas N leituras lançam
  }
  const deps: AutomatorDeps = {
    lerRifas: async () => {
      if (s.lerFalha > 0) {
        s.lerFalha--
        throw new Error('timeout lendo página')
      }
      return s.leitura([...s.rifas])
    },
    submeter: async p => {
      s.posts.push(p)
      const acao = s.aoEnviar(p)
      if (acao === 'cria' || acao === 'cria-e-lanca') {
        numero += 7 // sequência compartilhada com outras contas
        s.rifas.push({ numero: String(numero).padStart(7, '0'), cpf: p.cpf })
      }
      if (acao === 'cria-e-lanca' || acao === 'lanca') throw new Error('socket hang up')
    },
    salvar: async l => {
      s.salvos.push({ ...l })
    },
    log: m => s.logs.push(m),
    deveParar: () => s.parar,
    esperaConfirmacaoMs: 1,
  }
  return { s, automator: new Automator(deps), deps }
}

describe('Automator — caminho feliz', () => {
  it('cria exatamente qtd rifas por linha, em ordem, e marca ok com os Nºs', async () => {
    const { s, automator } = siteMemoria([{ numero: '0000900', cpf: CPF_A }])
    const linhas = [linha(1, CPF_A, 2), linha(2, CPF_B, 1)]
    await automator.start(linhas)
    expect(s.posts.map(p => p.cpf)).toEqual([CPF_A, CPF_A, CPF_B])
    expect(linhas.map(l => l.status)).toEqual(['ok', 'ok'])
    expect(linhas[0]!.base_cpf).toBe(1) // CPF já tinha 1 rifa antes
    expect(linhas[0]!.confirmadas).toBe(2)
    expect(linhas[0]!.numeros.split(', ')).toHaveLength(2)
    expect(s.posts.every(p => p.qtd === 1)).toBe(true)
  })

  it('não reenvia linha já ok (retomada)', async () => {
    const { s, automator } = siteMemoria()
    await automator.start([linha(1, CPF_A, 1, { status: 'ok' })])
    expect(s.posts).toHaveLength(0)
  })

  it('grava enviadas ANTES de cada POST', async () => {
    const { s, automator } = siteMemoria()
    let enviadasGravadasNoPost = -1
    s.aoEnviar = () => {
      enviadasGravadasNoPost = s.salvos.at(-1)!.enviadas
      return 'cria'
    }
    await automator.start([linha(1, CPF_A, 1)])
    expect(enviadasGravadasNoPost).toBe(1)
  })
})

describe('Automator — nunca cria além do pedido', () => {
  it('REGRESSÃO: leitura que não enxerga a rifa criada → 1 envio só, job para com erro', async () => {
    const { s, automator } = siteMemoria()
    s.leitura = () => [] // como o bug do Nº 0→0: a leitura nunca mostra nada
    const l = linha(1, CPF_A, 1)
    await expect(automator.start([l])).rejects.toBeInstanceOf(JobAbortado)
    expect(s.posts).toHaveLength(1)
    expect(s.rifas).toHaveLength(1)
    expect(l.status).toBe('erro')
    expect(l.erro).toMatch(/Confira no site/)
  })

  it('site ignora o POST → não reenvia; para e pede conferência', async () => {
    const { s, automator } = siteMemoria()
    s.aoEnviar = () => 'ignora'
    const l = linha(1, CPF_A, 3)
    await expect(automator.start([l])).rejects.toBeInstanceOf(JobAbortado)
    expect(s.posts).toHaveLength(1)
  })

  it('POST cria mas a resposta lança erro → conta na tabela e segue sem duplicar', async () => {
    const { s, automator } = siteMemoria()
    s.aoEnviar = () => 'cria-e-lanca'
    const l = linha(1, CPF_A, 2)
    await automator.start([l])
    expect(s.posts).toHaveLength(2)
    expect(s.rifas).toHaveLength(2)
    expect(l.status).toBe('ok')
  })

  it('site atrasado: rifa aparece só na segunda leitura → confirma sem reenviar', async () => {
    const { s, automator } = siteMemoria()
    let atrasar = true
    s.leitura = r => {
      if (atrasar && r.length > 0) {
        atrasar = false
        return r.slice(0, -1)
      }
      return r
    }
    const l = linha(1, CPF_A, 1)
    await automator.start([l])
    expect(s.posts).toHaveLength(1)
    expect(l.status).toBe('ok')
  })

  it('falha de leitura após o POST → para sem reenviar', async () => {
    const { s, automator } = siteMemoria()
    s.aoEnviar = () => {
      s.lerFalha = 2
      return 'cria'
    }
    const l = linha(1, CPF_A, 3)
    await expect(automator.start([l])).rejects.toThrow(/não confirmado/)
    expect(s.posts).toHaveLength(1)
  })

  it('tabela que encolhe é tratada como página não confiável', async () => {
    const { s, automator } = siteMemoria([{ numero: '0000001', cpf: CPF_B }, { numero: '0000002', cpf: CPF_B }])
    s.aoEnviar = () => {
      s.leitura = r => r.slice(2)
      return 'cria'
    }
    await expect(automator.start([linha(1, CPF_A, 2)])).rejects.toThrow(/encolheu/)
    expect(s.posts).toHaveLength(1)
  })

  it('teto absoluto: com enviadas = qtd nunca envia, mesmo que a leitura diga que falta', async () => {
    const { s, automator } = siteMemoria()
    const l = linha(1, CPF_A, 2, { base_cpf: 0, enviadas: 2, confirmadas: 0 })
    await expect(automator.start([l])).rejects.toThrow(/2 envio\(s\) feitos e só 0 confirmado/)
    expect(s.posts).toHaveLength(0)
  })

  it('soma de POSTs nunca passa de qtd mesmo com o site respondendo tudo errado', async () => {
    for (const acao of ['ignora', 'lanca', 'cria-e-lanca', 'cria'] as const) {
      for (const leituraQuebrada of [false, true]) {
        const { s, automator } = siteMemoria()
        s.aoEnviar = () => acao
        if (leituraQuebrada) s.leitura = () => []
        const linhas = [linha(1, CPF_A, 3), linha(2, CPF_B, 2)]
        await automator.start(linhas).catch(() => undefined)
        expect(s.posts.filter(p => p.cpf === CPF_A).length).toBeLessThanOrEqual(3)
        expect(s.posts.filter(p => p.cpf === CPF_B).length).toBeLessThanOrEqual(2)
      }
    }
  })
})

describe('Automator — retomada após queda', () => {
  it('queda durante o POST: retomada reconta e não reenvia o que entrou', async () => {
    const { s, automator } = siteMemoria()
    // Estado gravado antes da queda: base medida, 1 envio registrado, rifa entrou no site.
    s.rifas.push({ numero: '0001010', cpf: CPF_A })
    const l = linha(1, CPF_A, 2, { base_cpf: 0, enviadas: 1, status: 'pendente' })
    await automator.start([l])
    expect(s.posts).toHaveLength(1) // só a que faltava
    expect(l.status).toBe('ok')
    expect(l.confirmadas).toBe(2)
  })

  it('queda durante o POST que não entrou: com enviadas = qtd, pede conferência em vez de reenviar', async () => {
    const { s, automator } = siteMemoria()
    const l = linha(1, CPF_A, 1, { base_cpf: 0, enviadas: 1 })
    await expect(automator.start([l])).rejects.toBeInstanceOf(JobAbortado)
    expect(s.posts).toHaveLength(0)
  })

  it('base por CPF é medida uma vez e mantida na retomada', async () => {
    const { s, automator } = siteMemoria([{ numero: '0000500', cpf: CPF_A }])
    const l = linha(1, CPF_A, 1, { base_cpf: 1 })
    s.rifas.push({ numero: '0000600', cpf: CPF_A }) // criada antes da queda
    await automator.start([l])
    expect(s.posts).toHaveLength(0)
    expect(l.status).toBe('ok')
    expect(l.base_cpf).toBe(1)
  })

  it('mesmo CPF em duas linhas: a segunda mede a base depois da primeira', async () => {
    const { s, automator } = siteMemoria()
    const linhas = [linha(1, CPF_A, 1), linha(2, CPF_A, 2)]
    await automator.start(linhas)
    expect(s.posts).toHaveLength(3)
    expect(linhas[1]!.base_cpf).toBe(1)
  })
})

describe('Automator — controle e legado', () => {
  it('linha da versão antiga (base pelo Nº) nunca é enviada', async () => {
    const { s, automator } = siteMemoria()
    const l = linha(1, CPF_A, 1, { base: 0, status: 'erro', erro: 'site não registrou a submissão (Nº 0→0)' })
    await automator.start([l])
    expect(s.posts).toHaveLength(0)
    expect(l.status).toBe('erro')
    expect(l.erro).toMatch(/versão anterior/)
  })

  it('pausa entre envios deixa a linha pendente com o progresso salvo', async () => {
    const { s, automator } = siteMemoria()
    s.aoEnviar = () => {
      s.parar = true
      return 'cria'
    }
    const l = linha(1, CPF_A, 3)
    await automator.start([l])
    expect(s.posts).toHaveLength(1)
    expect(l.status).toBe('pendente')
    expect(l.confirmadas).toBe(1)
    expect(l.enviadas).toBe(1)
  })

  it('falha na leitura inicial aborta sem enviar', async () => {
    const { s, automator } = siteMemoria()
    s.lerFalha = 1
    const l = linha(1, CPF_A, 1)
    await expect(automator.start([l])).rejects.toThrow(/não foi possível ler/)
    expect(s.posts).toHaveLength(0)
    expect(l.base_cpf).toBeNull()
  })

  it('se salvar falhar, nada é enviado', async () => {
    const { s, deps } = siteMemoria()
    const automator = new Automator({
      ...deps,
      salvar: async l => {
        if (l.enviadas > 0) throw new Error('banco fora')
      },
    })
    await expect(automator.start([linha(1, CPF_A, 1)])).rejects.toThrow(/banco fora/)
    expect(s.posts).toHaveLength(0)
  })
})
