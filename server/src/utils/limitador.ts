// Trava por IP após falhas seguidas de PIN (anti força-bruta). Estado em memória:
// o Render free roda uma instância só; um restart zera as travas, o que é aceitável.

export interface LimitadorOpts {
  maxFalhas?: number
  janelaMs?: number
  bloqueioMs?: number
  agora?: () => number
}

interface Registro {
  falhas: number
  inicio: number
  bloqueadoAte: number
}

export interface Limitador {
  // ms restantes de bloqueio (0 = liberado)
  bloqueado: (chave: string) => number
  falhou: (chave: string) => void
  acertou: (chave: string) => void
}

export function criarLimitador(opts: LimitadorOpts = {}): Limitador {
  const maxFalhas = opts.maxFalhas ?? 5
  const janelaMs = opts.janelaMs ?? 15 * 60_000
  const bloqueioMs = opts.bloqueioMs ?? 15 * 60_000
  const agora = opts.agora ?? Date.now
  const registros = new Map<string, Registro>()

  const limpar = (t: number) => {
    for (const [k, r] of registros) {
      if (r.bloqueadoAte <= t && t - r.inicio > janelaMs) registros.delete(k)
    }
  }

  return {
    bloqueado: chave => {
      const r = registros.get(chave)
      if (!r) return 0
      return Math.max(0, r.bloqueadoAte - agora())
    },
    falhou: chave => {
      const t = agora()
      if (registros.size > 10_000) limpar(t)
      let r = registros.get(chave)
      if (!r || (r.bloqueadoAte <= t && t - r.inicio > janelaMs)) {
        r = { falhas: 0, inicio: t, bloqueadoAte: 0 }
        registros.set(chave, r)
      }
      r.falhas++
      if (r.falhas >= maxFalhas) {
        r.bloqueadoAte = t + bloqueioMs
        r.falhas = 0
        r.inicio = t
      }
    },
    acertou: chave => {
      registros.delete(chave)
    },
  }
}
