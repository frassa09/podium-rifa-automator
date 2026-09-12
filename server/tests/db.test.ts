import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Banco } from '../src/data/db.ts'
import type { Pessoa } from '../src/types.ts'

function novoBanco(): { banco: Banco; limpar: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'rifa-test-'))
  return { banco: Banco.abrir(join(dir, 'test.db')), limpar: () => rmSync(dir, { recursive: true, force: true }) }
}

const p: Pessoa = { nome: 'Maria', cpf: '86730169087', telefone: '11987654321', email: 'm@x.com', qtd: 1 }

describe('Banco', () => {
  it('persiste e lê config', () => {
    const { banco, limpar } = novoBanco()
    banco.gravarConfig({ cpf: '86730169087', senha: 'x', turma: '6474' })
    expect(banco.lerConfig()).toEqual({ cpf: '86730169087', senha: 'x', turma: '6474' })
    limpar()
  })

  it('cria job com linhas e resumo', () => {
    const { banco, limpar } = novoBanco()
    const id = banco.criarJob([p, { ...p, nome: 'João', cpf: '12345678900' }])
    expect(banco.linhasDoJob(id)).toHaveLength(2)
    expect(banco.linhasDoJob(id)[0]?.seq).toBe(1)
    expect(banco.resumoJob(id)).toEqual({ total: 2, ok: 0, erro: 0, pendente: 2, ativo: false })
    limpar()
  })

  it('atualiza linha e reprocessa erros', () => {
    const { banco, limpar } = novoBanco()
    const id = banco.criarJob([p])
    const [linha] = banco.linhasDoJob(id)
    banco.atualizarLinha({ ...linha!, status: 'erro', erro: 'CPF inválido' })
    expect(banco.resumoJob(id).erro).toBe(1)
    banco.reprocessarErros(id)
    expect(banco.linhasDoJob(id)[0]?.status).toBe('pendente')
    limpar()
  })

  it('logs são registrados com nível', () => {
    const { banco, limpar } = novoBanco()
    banco.registrarLog('olá', 'info')
    expect(banco.logs(0, 10).join(' ')).toContain('olá')
    limpar()
  })
})