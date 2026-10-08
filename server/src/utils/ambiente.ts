export const PIN_MIN_PRODUCAO = 8

// Em produção (Render ou NODE_ENV=production) o app fica exposto na internet com poder
// de criar rifas reais: sem PIN forte ou sem banco persistente, o boot é recusado.
// Sem banco persistente um job perdido pode ser recriado e duplicar rifas.
export function emProducao(env: NodeJS.ProcessEnv): boolean {
  return env.RENDER === 'true' || env.NODE_ENV === 'production'
}

export function errosAmbienteProducao(env: NodeJS.ProcessEnv): string[] {
  if (!emProducao(env)) return []
  const erros: string[] = []
  const pin = env.RIFA_PIN ?? ''
  if (pin.length < PIN_MIN_PRODUCAO) {
    erros.push(`RIFA_PIN é obrigatório em produção, com no mínimo ${PIN_MIN_PRODUCAO} caracteres.`)
  }
  if (!env.DATABASE_URL) {
    erros.push('DATABASE_URL é obrigatório em produção (o disco do Render é apagado a cada deploy/restart).')
  }
  return erros
}
