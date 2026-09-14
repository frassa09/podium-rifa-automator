import { SqliteBanco } from './sqliteBanco.ts'
import type { Banco } from './banco.ts'

export type { Banco }

export async function abrirBanco(opts: { caminho?: string; url?: string } = {}): Promise<Banco> {
  const url = opts.url ?? process.env.DATABASE_URL
  if (url) {
    const mod = await import('./postgresBanco.ts')
    return mod.PostgresBanco.abrir(url)
  }
  return SqliteBanco.abrir(opts.caminho)
}