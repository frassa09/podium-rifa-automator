import { describe, expect, it } from 'vitest'
import { validarCPF, maskCPF } from '../src/utils/cpf.ts'
import { maskPhone } from '../src/utils/masks.ts'

describe('validarCPF', () => {
  it('aceita CPF válido com máscara', () => {
    expect(validarCPF('867.301.690-87')).toBe(true)
  })
  it('aceita CPF válido sem máscara', () => {
    expect(validarCPF('86730169087')).toBe(true)
  })
  it('rejeita dígito verificador errado', () => {
    expect(validarCPF('867.301.690-88')).toBe(false)
  })
  it('rejeita todos dígitos iguais', () => {
    expect(validarCPF('111.111.111-11')).toBe(false)
  })
  it('rejeita tamanho errado', () => {
    expect(validarCPF('123')).toBe(false)
  })
  it('rejeita vazio', () => {
    expect(validarCPF('')).toBe(false)
  })
})

describe('maskCPF', () => {
  it('formata 11 dígitos com pontos e traço', () => {
    expect(maskCPF('86730169087')).toBe('867.301.690-87')
  })
  it('formata CPF já mascarado (idempotente)', () => {
    expect(maskCPF('867.301.690-87')).toBe('867.301.690-87')
  })
  it('ignora letras', () => {
    expect(maskCPF('867.301.690-87x')).toBe('867.301.690-87')
  })
})

describe('maskPhone', () => {
  it('formata celular 11 dígitos', () => {
    expect(maskPhone('11987654321')).toBe('(11) 98765-4321')
  })
  it('formata fixo 10 dígitos', () => {
    expect(maskPhone('1138765432')).toBe('(11) 3876-5432')
  })
  it('formata telefone já mascarado', () => {
    expect(maskPhone('(11) 98765-4321')).toBe('(11) 98765-4321')
  })
  it('retorna input se menos de 10 dígitos', () => {
    expect(maskPhone('11987')).toBe('11987')
  })
})
