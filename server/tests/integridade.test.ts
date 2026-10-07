// Cenários de integridade contra o simulador realista (spec 2026-10-07 §3).
import { afterEach, describe, expect, it } from 'vitest'
import { Automator } from '../src/engine/automator.ts'
import { PodiumSession } from '../src/podium/session.ts'
import type { LinhaJob } from '../src/types.ts'
import { iniciarSiteFalso, type SiteFalso } from './fakes/siteFalso.ts'

const linha = (qtd: number): LinhaJob => ({
  id: 1, job_id: 1, seq: 1, nome: 'Comprador Ficticio Teste', cpf: '90000009953',
  telefone: '11900009999', email: 'teste@exemplo.com.br', qtd, status: 'pendente', erro: null, numeros: '',
  base: null, enviadas: 0, base_cpf: null, tentativas: 0, confirmadas: 0,
})

// Mesmo encadeamento de server.ts (rodarJob), sem banco.
async function rodar(site: SiteFalso, l: LinhaJob): Promise<LinhaJob> {
  const sessao = await PodiumSession.login('90000009953', 'senha', { baseUrl: site.baseUrl })
  const automator = new Automator({
    getSessao: async () => sessao,
    submeterLinha: async (s, p) => (s as PodiumSession).submeterRifa(p),
    contarRifasDoCpf: async (s, cpf) => (s as PodiumSession).contarRifasDoCpf(cpf),
    salvarLinha: async () => {},
    log: () => {},
  })
  await automator.start([l])
  return l
}

let site: SiteFalso | undefined
afterEach(async () => { await site?.fechar() })

describe('Cenário Nº 1129–1131 da captura real (qtd=1, página ISO-8859-1)', () => {
  // Captura de 2026-10-07: Nº 1129, 1130 e 1131 do mesmo comprador, criados em
  // 17:15:01, :04 e :07 de 15/09. O motor antigo lia o rótulo "Nº" como "N�"
  // (Latin-1 lido como UTF-8), medía 0 antes e depois de cada envio e reenviava 3 vezes.

  it('qtd=1 → exatamente 1 POST (Nº 1129) e linha ok', async () => {
    site = await iniciarSiteFalso({ proximoNumero: 1129 })
    const l = await rodar(site, linha(1))
    expect(site.posts.map(p => p.numero)).toEqual([1129])
    expect(l).toMatchObject({ status: 'ok', tentativas: 1, confirmadas: 1 })
  })

  it('com outros vendedores criando no meio (Nº global com saltos), ainda exatamente 1 POST', async () => {
    site = await iniciarSiteFalso({ proximoNumero: 1129, outrosVendedoresPorEnvio: 5 })
    const l = await rodar(site, linha(1))
    expect(site.posts).toHaveLength(1)
    expect(l.status).toBe('ok')
  })

  it('qtd=3 com saltos de outros vendedores → exatamente 3 POSTs', async () => {
    site = await iniciarSiteFalso({ proximoNumero: 1129, outrosVendedoresPorEnvio: 46 })
    const l = await rodar(site, linha(3))
    expect(site.posts.map(p => p.numero)).toEqual([1129, 1176, 1223])
    expect(l).toMatchObject({ status: 'ok', confirmadas: 3 })
  })

  it('a mesma página servida em UTF-8 também dá exatamente 1 POST', async () => {
    site = await iniciarSiteFalso({ proximoNumero: 1129, codificacao: 'utf8' })
    const l = await rodar(site, linha(1))
    expect(site.posts).toHaveLength(1)
    expect(l.status).toBe('ok')
  })
})
