import { describe, expect, it } from 'vitest'
import { criarLimitador } from '../src/utils/limitador.ts'

function relogio() {
  let t = 1_000_000
  return { agora: () => t, avancar: (ms: number) => (t += ms) }
}

describe('limitador de PIN', () => {
  it('bloqueia após maxFalhas e libera depois do bloqueio', () => {
    const r = relogio()
    const l = criarLimitador({ maxFalhas: 3, bloqueioMs: 60_000, agora: r.agora })
    l.falhou('ip')
    l.falhou('ip')
    expect(l.bloqueado('ip')).toBe(0)
    l.falhou('ip')
    expect(l.bloqueado('ip')).toBe(60_000)
    r.avancar(60_000)
    expect(l.bloqueado('ip')).toBe(0)
  })

  it('isola chaves diferentes', () => {
    const l = criarLimitador({ maxFalhas: 1 })
    l.falhou('a')
    expect(l.bloqueado('a')).toBeGreaterThan(0)
    expect(l.bloqueado('b')).toBe(0)
  })

  it('acerto zera as falhas acumuladas', () => {
    const l = criarLimitador({ maxFalhas: 2 })
    l.falhou('ip')
    l.acertou('ip')
    l.falhou('ip')
    expect(l.bloqueado('ip')).toBe(0)
  })

  it('falhas fora da janela não somam', () => {
    const r = relogio()
    const l = criarLimitador({ maxFalhas: 2, janelaMs: 1_000, agora: r.agora })
    l.falhou('ip')
    r.avancar(1_001)
    l.falhou('ip')
    expect(l.bloqueado('ip')).toBe(0)
  })
})
