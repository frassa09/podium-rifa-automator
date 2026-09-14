import { expect, it } from 'vitest'
import type { Banco } from '../../src/data/banco.ts'
import type { Pessoa } from '../../src/types.ts'

export const pessoaExemplo: Pessoa = {
  nome: 'Maria',
  cpf: '86730169087',
  telefone: '11987654321',
  email: 'm@x.com',
  qtd: 1,
}

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
    expect(await banco.resumoJob(id)).toEqual({ total: 2, ok: 0, erro: 0, pendente: 2, ativo: false })
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

  it('logs são registrados com nível', async () => {
    const banco = await novo()
    await banco.registrarLog('olá', 'info')
    expect((await banco.logs(0, 10)).join(' ')).toContain('olá')
  })

  it('cancelarJob cancela job rodando e é idempotente', async () => {
    const banco = await novo()
    const id = await banco.criarJob([pessoaExemplo])
    await banco.atualizarStatusJob(id, 'rodando')
    expect(await banco.cancelarJob(id)).toBe(true)
    expect((await banco.resumoJob(id)).ativo).toBe(false)
    expect(await banco.cancelarJob(id)).toBe(false)
  })

  it('cancelarJob retorna false para job inexistente', async () => {
    const banco = await novo()
    expect(await banco.cancelarJob(999)).toBe(false)
  })

  it('single-flight: só um job pode estar rodando por vez', async () => {
    const banco = await novo()
    const id1 = await banco.criarJob([pessoaExemplo])
    const id2 = await banco.criarJob([pessoaExemplo])
    expect(await banco.tentarIniciarJob(id1)).toBe(true)
    expect(await banco.tentarIniciarJob(id2)).toBe(false)
    expect(await banco.tentarIniciarJob(id1)).toBe(false)
    await banco.cancelarJob(id1)
    expect(await banco.tentarIniciarJob(id2)).toBe(true)
  })

  it('reconciliarBoot devolve rodando e cadastrando a pendente', async () => {
    const banco = await novo()
    const id = await banco.criarJob([pessoaExemplo])
    await banco.atualizarStatusJob(id, 'rodando')
    const linha = (await banco.linhasDoJob(id))[0]!
    await banco.atualizarLinha({ ...linha, status: 'cadastrando' })
    await banco.reconciliarBoot()
    expect((await banco.resumoJob(id)).ativo).toBe(false)
    expect((await banco.linhasDoJob(id))[0]?.status).toBe('pendente')
  })
}