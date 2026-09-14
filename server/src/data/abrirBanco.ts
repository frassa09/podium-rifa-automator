import { SqliteBanco } from './sqliteBanco.ts'
import type { Banco } from './banco.ts'

export type { Banco }

export async function abrirBanco(opts: { caminho?: string; url?: string } = {}): Promise<Banco> {
  const url = opts.url ?? process.env.DATABASE_URL
  if (url) {
    throw new Error('Suporte a DATABASE_URL (PostgresBanco) é adicionado na etapa seguinte')
  }
  return SqliteBanco.abrir(opts.caminho)
}