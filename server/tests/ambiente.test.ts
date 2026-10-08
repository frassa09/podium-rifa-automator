import { describe, expect, it } from 'vitest'
import { errosAmbienteProducao } from '../src/utils/ambiente.ts'

const DB = 'postgresql://u:s@h/db?sslmode=require'

describe('validação de ambiente de produção', () => {
  it('fora de produção não exige nada (modo LAN)', () => {
    expect(errosAmbienteProducao({})).toEqual([])
  })

  it('no Render exige PIN e DATABASE_URL', () => {
    expect(errosAmbienteProducao({ RENDER: 'true' })).toHaveLength(2)
  })

  it('PIN curto é recusado em produção', () => {
    const erros = errosAmbienteProducao({ NODE_ENV: 'production', RIFA_PIN: '1234', DATABASE_URL: DB })
    expect(erros).toHaveLength(1)
    expect(erros[0]).toMatch(/RIFA_PIN/)
  })

  it('PIN forte + banco passa', () => {
    expect(errosAmbienteProducao({ RENDER: 'true', RIFA_PIN: '73915482', DATABASE_URL: DB })).toEqual([])
  })
})
