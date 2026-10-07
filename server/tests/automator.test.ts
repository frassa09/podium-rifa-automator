import { describe, expect, it } from 'vitest'
import { Automator, JobAbortado, type AutomatorDeps } from '../src/engine/automator.ts'
import type { LinhaJob, Pessoa } from '../src/types.ts'

const CPF = '86730169087'

const linha = (id: number, qtd = 1, extra: Partial<LinhaJob> = {}): LinhaJob => ({
  id, job_id: 1, seq: id, nome: 'Maria', cpf: CPF,
  telefone: '11987654321', email: 'm@x.com', qtd, status: 'pendente', erro: null, numeros: '',
  base: null, enviadas: 0, base_cpf: null, tentativas: 0, confirmadas: 0, ...extra,
})

// Site em memória: cada POST cria uma rifa para o CPF (a não ser que o teste troque).
function siteMock(inicial: Record<string, number> = {}) {
  const porCpf = new Map<string, number>(Object.entries(inicial))
  const posts: Pessoa[] = []
  const salvas: LinhaJob[] = []
  const criar = (cpf: string) => porCpf.set(cpf, (porCpf.get(cpf) ?? 0) + 1)
  const deps: AutomatorDeps = {
    getSessao: async () => ({}),
    submeterLinha: async (_s, p) => { posts.push(p); criar(p.cpf) },
    contarRifasDoCpf: async (_s, cpf) => porCpf.get(cpf) ?? 0,
    salvarLinha: async l => { salvas.push({ ...l }) },
    log: () => {},
  }
  return { deps, posts, salvas, porCpf, criar }
}

describe('Automator — caminho feliz', () => {
  it('processa todas as linhas na ordem', async () => {
    const { deps, posts } = siteMock()
    const linhas = [linha(1, 1, { cpf: '11111111111' }), linha(2, 1, { cpf: '22222222222' }), linha(3, 1, { cpf: '33333333333' })]
    await new Automator(deps).start(linhas)
    expect(posts.map(p => p.cpf)).toEqual(['11111111111', '22222222222', '33333333333'])
    expect(linhas.map(l => l.status)).toEqual(['ok', 'ok', 'ok'])
  })

  it('qtd=3 → exatamente 3 POSTs, confirmadas 3', async () => {
    const { deps, posts } = siteMock()
    const l = linha(1, 3)
    await new Automator(deps).start([l])
    expect(posts).toHaveLength(3)
    expect(l).toMatchObject({ status: 'ok', tentativas: 3, confirmadas: 3, enviadas: 3, base_cpf: 0 })
  })

  it('CPF que já tinha rifas: base é a contagem anterior, não zero', async () => {
    const { deps, posts } = siteMock({ [CPF]: 5 })
    const l = linha(1, 1)
    await new Automator(deps).start([l])
    expect(posts).toHaveLength(1)
    expect(l).toMatchObject({ status: 'ok', base_cpf: 5, confirmadas: 1 })
  })

  it('mesmo CPF em duas linhas do lote: cada linha mede a própria base', async () => {
    const { deps, posts } = siteMock()
    const linhas = [linha(1, 2), linha(2, 1)]
    await new Automator(deps).start(linhas)
    expect(posts).toHaveLength(3)
    expect(linhas.map(l => [l.status, l.base_cpf])).toEqual([['ok', 0], ['ok', 2]])
  })

  it('pula linha já ok (retomada)', async () => {
    const { deps, posts } = siteMock()
    await new Automator(deps).start([linha(1, 1, { status: 'ok' }), linha(2, 1, { cpf: '22222222222' })])
    expect(posts.map(p => p.cpf)).toEqual(['22222222222'])
  })

  it('grava cadastrando, base e tentativa antes do POST, e termina ok', async () => {
    const { deps, salvas, posts } = siteMock()
    let salvasAntesDoPost = -1
    const sub = deps.submeterLinha
    deps.submeterLinha = async (s, p) => { salvasAntesDoPost = salvas.length; await sub(s, p) }
    await new Automator(deps).start([linha(1)])
    expect(posts).toHaveLength(1)
    expect(salvas[0]?.status).toBe('cadastrando')
    expect(salvas[salvasAntesDoPost - 1]).toMatchObject({ tentativas: 1, base_cpf: 0 })
    expect(salvas.at(-1)?.status).toBe('ok')
  })

  it('POST que cria a rifa mas lança erro (timeout depois de criar) → mede, ok, sem reenvio', async () => {
    const { deps, posts, criar } = siteMock()
    deps.submeterLinha = async (_s, p) => { posts.push(p); criar(p.cpf); throw new Error('timeout') }
    const l = linha(1)
    await new Automator(deps).start([l])
    expect(posts).toHaveLength(1)
    expect(l.status).toBe('ok')
  })

  it('cria mais do que o pedido (nunca deveria): ok com alerta, sem POST extra', async () => {
    const { deps, posts, criar } = siteMock()
    const logs: string[] = []
    deps.log = m => logs.push(m)
    deps.submeterLinha = async (_s, p) => { posts.push(p); criar(p.cpf); criar(p.cpf) }
    const l = linha(1, 1)
    await new Automator(deps).start([l])
    expect(posts).toHaveLength(1)
    expect(l.status).toBe('ok')
    expect(logs.join(' ')).toMatch(/2 rifa\(s\) confirmada\(s\) para qtd 1/)
  })
})

describe('Automator — at-most-once (nunca reenvia sem prova)', () => {
  it('POST lança erro e nada foi criado → incerto, job para, 1 POST só', async () => {
    const { deps, posts } = siteMock()
    deps.submeterLinha = async (_s, p) => { posts.push(p); throw new Error('rede') }
    const l = linha(1, 3)
    await expect(new Automator(deps).start([l, linha(2, 1, { cpf: '22222222222' })])).rejects.toBeInstanceOf(JobAbortado)
    expect(posts).toHaveLength(1)
    expect(l).toMatchObject({ status: 'incerto', tentativas: 1, confirmadas: 0 })
  })

  it('POST responde 302 mas o site não criou → incerto, 1 POST só', async () => {
    const { deps, posts } = siteMock()
    deps.submeterLinha = async (_s, p) => { posts.push(p); return { status: 302, location: 'main.php?conteudo=form_rifa' } }
    const l = linha(1)
    await expect(new Automator(deps).start([l])).rejects.toThrow(/incerto/)
    expect(posts).toHaveLength(1)
  })

  it('medição pós-envio falha → incerto (não erro), 1 POST só', async () => {
    const { deps, posts, porCpf } = siteMock()
    let leituras = 0
    deps.contarRifasDoCpf = async (_s, cpf) => {
      if (++leituras > 2) throw new Error('leitura indisponível')
      return porCpf.get(cpf) ?? 0
    }
    const l = linha(1, 2)
    await expect(new Automator(deps).start([l])).rejects.toBeInstanceOf(JobAbortado)
    expect(posts).toHaveLength(1)
    expect(l.status).toBe('incerto')
  })

  it('medição inicial falha → erro, sem base e sem POST', async () => {
    const { deps, posts } = siteMock()
    deps.contarRifasDoCpf = async () => { throw new Error('site indisponível') }
    const l = linha(1)
    await expect(new Automator(deps).start([l])).rejects.toThrow(/Abortando job/)
    expect(l).toMatchObject({ status: 'erro', base_cpf: null, tentativas: 0 })
    expect(posts).toHaveLength(0)
  })

  it('contagem abaixo da base (tabela truncada) → incerto, sem POST', async () => {
    const { deps, posts, porCpf } = siteMock({ [CPF]: 4 })
    let leituras = 0
    deps.contarRifasDoCpf = async (_s, cpf) => (++leituras === 1 ? porCpf.get(cpf) ?? 0 : 1)
    const l = linha(1)
    await expect(new Automator(deps).start([l])).rejects.toThrow(/menos que a base/)
    expect(posts).toHaveLength(0)
    expect(l.status).toBe('incerto')
  })

  it('falha ao gravar a tentativa → job para ANTES do POST', async () => {
    const { deps, posts } = siteMock()
    deps.salvarLinha = async l => { if (l.tentativas > 0) throw new Error('banco caiu') }
    await expect(new Automator(deps).start([linha(1)])).rejects.toThrow('banco caiu')
    expect(posts).toHaveLength(0)
  })

  it('linha incerta de execução anterior não é tocada; as outras seguem', async () => {
    const { deps, posts } = siteMock()
    const incerta = linha(1, 1, { status: 'incerto', base_cpf: 0, tentativas: 1 })
    await new Automator(deps).start([incerta, linha(2, 1, { cpf: '22222222222' })])
    expect(posts.map(p => p.cpf)).toEqual(['22222222222'])
    expect(incerta.status).toBe('incerto')
  })
})

describe('Automator — retomada após crash', () => {
  it('crash entre gravar a tentativa e o POST → incerto, nenhum POST novo', async () => {
    const { deps, posts } = siteMock()
    const l = linha(1, 2, { status: 'cadastrando', base_cpf: 0, tentativas: 1 })
    await expect(new Automator(deps).start([l])).rejects.toThrow(/incerto/)
    expect(posts).toHaveLength(0)
  })

  it('crash entre o POST e a medição → confirma pela contagem e só envia o que falta', async () => {
    const { deps, posts } = siteMock({ [CPF]: 1 })
    const l = linha(1, 2, { status: 'cadastrando', base_cpf: 0, tentativas: 1 })
    await new Automator(deps).start([l])
    expect(posts).toHaveLength(1)
    expect(l).toMatchObject({ status: 'ok', tentativas: 2, confirmadas: 2 })
  })

  it('envios registrados sem base → incerto, sem POST', async () => {
    const { deps, posts } = siteMock()
    const l = linha(1, 1, { base_cpf: null, tentativas: 1 })
    await expect(new Automator(deps).start([l])).rejects.toThrow(/sem contagem base/)
    expect(posts).toHaveLength(0)
  })
})

describe('Automator — cancelamento', () => {
  it('deveParar antes de começar → nenhum POST', async () => {
    const { deps, posts } = siteMock()
    deps.deveParar = () => true
    const linhas = [linha(1), linha(2)]
    await new Automator(deps).start(linhas)
    expect(posts).toHaveLength(0)
    expect(linhas.map(l => l.status)).toEqual(['pendente', 'pendente'])
  })

  it('cancelar durante o envio → nenhum POST depois, linha pendente com tentativa confirmada', async () => {
    const { deps, posts } = siteMock()
    let parar = false
    const sub = deps.submeterLinha
    deps.submeterLinha = async (s, p) => { parar = true; await sub(s, p) }
    deps.deveParar = () => parar
    const l = linha(1, 2)
    await new Automator(deps).start([l, linha(2, 1, { cpf: '22222222222' })])
    expect(posts).toHaveLength(1)
    expect(l).toMatchObject({ status: 'pendente', tentativas: 1, confirmadas: 1 })
  })
})

// Propriedade do spec §3: para qualquer comportamento do site, rifas criadas por CPF ≤ qtd,
// e se ficar abaixo a linha não termina ok.
function prng(semente: number): () => number {
  let a = semente >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('Automator — propriedade com site aleatório', () => {
  it('500 sementes: criadas ≤ qtd, POSTs ≤ qtd, e ok ⇒ criadas = qtd', async () => {
    for (let semente = 1; semente <= 500; semente++) {
      const r = prng(semente)
      const { deps, porCpf, criar } = siteMock()
      const postsPorLinha = new Map<string, number>()
      deps.submeterLinha = async (_s, p) => {
        postsPorLinha.set(p.cpf, (postsPorLinha.get(p.cpf) ?? 0) + 1)
        const x = r()
        if (x < 0.6) { criar(p.cpf); return { status: 302, location: 'main.php?conteudo=form_rifa' } }
        if (x < 0.75) { criar(p.cpf); throw new Error('timeout depois de criar') }
        if (x < 0.9) throw new Error('rede antes de criar')
        return { status: 500, location: '' }
      }
      deps.contarRifasDoCpf = async (_s, cpf) => {
        if (r() < 0.1) throw new Error('leitura falhou')
        return porCpf.get(cpf) ?? 0
      }
      const linhas = Array.from({ length: 4 }, (_, i) => linha(i + 1, 1 + Math.floor(r() * 4), { cpf: String(10000000000 + i) }))
      await new Automator(deps).start(linhas).catch(e => { if (!(e instanceof JobAbortado)) throw e })

      for (const l of linhas) {
        const criadas = porCpf.get(l.cpf) ?? 0
        const contexto = `semente ${semente}, linha ${l.id}: qtd ${l.qtd}, criadas ${criadas}, status ${l.status}`
        expect(criadas, contexto).toBeLessThanOrEqual(l.qtd)
        expect(postsPorLinha.get(l.cpf) ?? 0, contexto).toBeLessThanOrEqual(l.qtd)
        // Abaixo do pedido nunca é ok (pode ser erro, incerto, ou pendente se o job parou antes).
        if (l.status === 'ok') expect(criadas, contexto).toBe(l.qtd)
      }
    }
  })
})
