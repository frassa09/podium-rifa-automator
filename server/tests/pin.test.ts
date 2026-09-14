import { describe, expect, it } from 'vitest'
import { pinValido } from '../src/utils/pin.ts'

describe('pinValido', () => {
  it('aceita o PIN correto e rejeita errado/vazio', () => {
    expect(pinValido('1234', '1234')).toBe(true)
    expect(pinValido('1234', '0000')).toBe(false)
    expect(pinValido('', '1234')).toBe(false)
  })

  it('tamanhos diferentes não quebram nem vazam (digest fixo de 32 bytes)', () => {
    expect(pinValido('x'.repeat(100), 'y')).toBe(false)
  })
})