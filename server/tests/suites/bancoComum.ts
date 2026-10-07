import { expect, it } from 'vitest'
import { LEASE_MS, type Banco } from '../../src/data/banco.ts'
import type { Pessoa } from '../../src/types.ts'

export const pessoaExemplo: Pessoa = {
  nome: 'Maria',
  cpf: '86730169087',
  telefone: '11987654321',
  email: 'm@x.com',
  qtd: 1,
}

// Bancos podem ser compartilhados entre testes (PGlite): cada teste de lock usa um instante
// muito à frente do anterior, então locks deixados por testes passados já expiraram.
let instante = 1_000_000
const novoInstante = () => (instante += 100 * LEASE_MS)

export function suíteComumBanco(novo: () => Promise<Banco>): void {
  it('persiste e lê config', async () => {
    const banco = await novo()
    await banco.gravarConfig({ cpf: '86730169087', senha: 'x', turma: '6474' })
    expect(await banco.lerConfig()).toEqual({ cpf: '86730169087', senha: 'x', turma: '6474' })
  })

  it('cria job com linhas e resumo', async () => {
    const banco = await novo()
    const id = await banco.criarJob([pessoaExemplo, { ...pessoaExemplo, nome: 'João', cpf: '12345678900' }])
    expect(await banco.linhasDoJob(id)).toHaveLength(2)
    expect((await banco.linhasDoJob(id))[0]?.seq).toBe(1)
    expect(await banco.resumoJob(id)).toEqual({ total: 2, ok: 0, erro: 0, incerto: 0, pendente: 2, ativo: false })
  })

  it('atualiza linha e reprocessa erros', async () => {
    const banco = await novo()
    const id = await banco.criarJob([pessoaExemplo])
    const linha = (await banco.linhasDoJob(id))[0]!
    await banco.atualizarLinha({ ...linha, status: 'erro', erro: 'CPF inválido' })
    expect((await banco.resumoJob(id)).erro).toBe(1)
    await banco.reprocessarErros(id)
    expect((await banco.linhasDoJob(id))[0]?.status).toBe('pendente')
  })

  it('persiste o write-ahead log (base_cpf, tentativas, confirmadas) e conta incerto no resumo', async () => {
    const banco = await novo()
    const id = await banco.criarJob([pessoaExemplo])
    const linha = (await banco.linhasDoJob(id))[0]!
    expect(linha).toMatchObject({ base_cpf: null, tentativas: 0, confirmadas: 0 })
    await banco.atualizarLinha({ ...linha, status: 'incerto', base_cpf: 7, tentativas: 2, confirmadas: 1 })
    expect((await banco.linhasDoJob(id))[0]).toMatchObject({ status: 'incerto', base_cpf: 7, tentativas: 2, confirmadas: 1 })
    expect(await banco.resumoJob(id)).toMatchObject({ incerto: 1, erro: 0, pendente: 0 })
  })

  it('reprocessar erros não toca em linhas incertas', async () => {
    const banco = await novo()
    const id = await banco.criarJob([pessoaExemplo, { ...pessoaExemplo, cpf: '12345678900' }])
    const [a, b] = await banco.linhasDoJob(id)
    await banco.atualizarLinha({ ...a!, status: 'erro', erro: 'x' })
    await banco.atualizarLinha({ ...b!, status: 'incerto', erro: 'y', base_cpf: 0, tentativas: 1 })
    await banco.reprocessarErros(id)
    expect((await banco.linhasDoJob(id)).map(l => l.status)).toEqual(['pendente', 'incerto'])
  })

  it('logs são registrados com nível', async () => {
    const banco = await novo()
    await banco.registrarLog('olá', 'info')
    expect((await banco.logs(0, 10)).join(' ')).toContain('olá')
  })

  it('lock: só um job com lock válido por vez, em qualquer instância', async () => {
    const banco = await novo()
    const id1 = await banco.criarJob([pessoaExemplo])
    const id2 = await banco.criarJob([pessoaExemplo])
    const t = novoInstante()
    expect(await banco.tentarIniciarJob(id1, 'A', t)).toBe(true)
    expect(await banco.tentarIniciarJob(id2, 'B', t)).toBe(false)
    expect(await banco.tentarIniciarJob(id1, 'B', t)).toBe(false)
    expect(await banco.lockValido(id1, t)).toBe(true)
    expect((await banco.resumoJob(id1)).ativo).toBe(true)
    await banco.liberarLock(id1, 'B', 'concluido') // dono errado: não faz nada
    expect(await banco.tentarIniciarJob(id2, 'B', t)).toBe(false)
    await banco.liberarLock(id1, 'A', 'concluido')
    expect(await banco.tentarIniciarJob(id2, 'B', t)).toBe(true)
    expect((await banco.listarJobs()).find(j => j.id === id1)?.status).toBe('concluido')
  })

  it('lock: expira sozinho; o dono antigo não consegue mais renovar', async () => {
    const banco = await novo()
    const id1 = await banco.criarJob([pessoaExemplo])
    const id2 = await banco.criarJob([pessoaExemplo])
    const t = novoInstante()
    expect(await banco.tentarIniciarJob(id1, 'A', t)).toBe(true)
    expect((await banco.renovarLock(id1, 'A', t + 10_000)).ok).toBe(true)
    const depois = t + 10_000 + LEASE_MS + 1
    expect(await banco.tentarIniciarJob(id2, 'B', depois)).toBe(true)
    expect((await banco.renovarLock(id1, 'A', depois)).ok).toBe(false)
    expect(await banco.lockValido(id1, depois)).toBe(false)
  })

  it('cancelar só sinaliza: status continua rodando até o runner liberar', async () => {
    const banco = await novo()
    const id = await banco.criarJob([pessoaExemplo])
    const t = novoInstante()
    expect(await banco.cancelarJob(id, t)).toBe(false) // sem lock: nada a sinalizar
    expect(await banco.cancelarJob(999, t)).toBe(false)
    await banco.tentarIniciarJob(id, 'A', t)
    expect(await banco.cancelarJob(id, t)).toBe(true)
    expect((await banco.resumoJob(id)).ativo).toBe(true)
    expect(await banco.renovarLock(id, 'A', t + 1)).toEqual({ ok: true, cancelar: true })
    await banco.liberarLock(id, 'A', 'pendente')
    expect((await banco.resumoJob(id)).ativo).toBe(false)
    expect(await banco.tentarIniciarJob(id, 'A', t + 2)).toBe(true)
    expect((await banco.renovarLock(id, 'A', t + 3)).cancelar).toBe(false)
  })

  it('reconciliar: lock expirado vira pendente; cadastrando com envio não confirmado vira incerto', async () => {
    const banco = await novo()
    const id = await banco.criarJob([pessoaExemplo, { ...pessoaExemplo, cpf: '12345678900' }])
    const t = novoInstante()
    await banco.tentarIniciarJob(id, 'A', t)
    const [a, b] = await banco.linhasDoJob(id)
    await banco.atualizarLinha({ ...a!, status: 'cadastrando', base_cpf: 0, tentativas: 1, confirmadas: 0 })
    await banco.atualizarLinha({ ...b!, status: 'cadastrando', base_cpf: 0, tentativas: 1, confirmadas: 1 })

    await banco.reconciliarExpirados(t + 1) // lock ainda válido: nada muda
    expect((await banco.linhasDoJob(id)).map(l => l.status)).toEqual(['cadastrando', 'cadastrando'])
    expect((await banco.resumoJob(id)).ativo).toBe(true)

    await banco.reconciliarExpirados(t + LEASE_MS + 1)
    const linhas = await banco.linhasDoJob(id)
    expect(linhas.map(l => l.status)).toEqual(['incerto', 'pendente'])
    expect(linhas[0]?.erro).toMatch(/confira no site/)
    expect((await banco.resumoJob(id)).ativo).toBe(false)
  })

  it('reconciliar: job rodando de versão antiga (sem lock) volta a pendente', async () => {
    const banco = await novo()
    const id = await banco.criarJob([pessoaExemplo])
    await banco.atualizarStatusJob(id, 'rodando')
    await banco.reconciliarExpirados()
    expect((await banco.resumoJob(id)).ativo).toBe(false)
  })
}
