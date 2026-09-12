import { validarCPF, apenasDigitos } from './cpf.ts'
import type { Pessoa } from '../types.ts'

export interface LinhaParseada {
  pessoa: Pessoa
  erros: string[]
}

export interface ResultadoParse {
  ok: LinhaParseada[]
  invalidas: LinhaParseada[]
  total: number
}

const ALIASES: Record<string, string[]> = {
  nome: ['nome', 'nome completo', 'nome do comprador', 'comprador'],
  cpf: ['cpf'],
  telefone: ['telefone', 'fone', 'celular', 'phone', 'tel'],
  email: ['email', 'e-mail', 'mail', 'correio'],
  qtd: ['qtd', 'quantidade', 'qtd de rifas', 'qtd rifas', 'numero de rifas', 'n de rifas'],
}

const normalize = (s: string): string => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()

function findCol(headers: string[]): Record<keyof Pessoa, number> {
  const idx: Record<string, number> = {}
  headers.forEach((h, i) => {
    const n = normalize(h)
    for (const [key, aliases] of Object.entries(ALIASES)) {
      if (aliases.includes(n)) {
        idx[key] = i
        break
      }
    }
  })
  return idx as Record<keyof Pessoa, number>
}

function validarLinha(p: Pessoa): string[] {
  const erros: string[] = []
  if (!p.nome || !p.nome.trim()) erros.push('Nome obrigatório')
  if (!validarCPF(p.cpf)) erros.push('CPF inválido')
  if (apenasDigitos(p.telefone).length < 10) erros.push('Telefone inválido')
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.email)) erros.push('E-mail inválido')
  if (!Number.isInteger(p.qtd) || p.qtd < 1) erros.push('Qtd deve ser inteiro ≥ 1')
  return erros
}

function deArray(rows: unknown[][]): ResultadoParse {
  const out: ResultadoParse = { ok: [], invalidas: [], total: 0 }
  if (!rows.length) return out
  const headers = (rows[0] as unknown[]).map(String)
  const idx = findCol(headers)
  if (idx.nome === undefined || idx.cpf === undefined) {
    throw new Error('Cabeçalhos não reconhecidos: use colunas Nome, CPF, Telefone, E-mail, Qtd')
  }
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] as unknown[]
    if (row.every(c => c === undefined || c === null || String(c).trim() === '')) continue
    const s = (i?: number): string =>
      i === undefined ? '' : String(row[i] ?? '').trim()
    const pessoa: Pessoa = {
      nome: s(idx.nome),
      cpf: apenasDigitos(s(idx.cpf)),
      telefone: apenasDigitos(s(idx.telefone)),
      email: s(idx.email),
      qtd: idx.qtd !== undefined ? Number(s(idx.qtd)) || 0 : 1,
    }
    out.total++
    const erros = validarLinha(pessoa)
    ;(erros.length ? out.invalidas : out.ok).push({ pessoa, erros })
  }
  return out
}

function deTexto(texto: string): ResultadoParse {
  const linhas = texto.replace(/\r/g, '').split('\n').filter(l => l.trim() !== '')
  if (!linhas.length) return { ok: [], invalidas: [], total: 0 }
  const sep = linhas[0]!.includes('\t') ? '\t' : linhas[0]!.includes(';') ? ';' : ','
  const rows = linhas.map(l => l.split(sep))
  return deArray(rows)
}

export async function parseLinhas(opts: {
  arquivo?: ArrayBuffer
  texto?: string
  nomeArquivo?: string
}): Promise<ResultadoParse> {
  if (opts.arquivo) {
    const XLSX = await import('xlsx')
    const wb = XLSX.read(new Uint8Array(opts.arquivo), { type: 'array' })
    const ws = wb.Sheets[wb.SheetNames[0]!]
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1 }) as unknown[][]
    return deArray(rows)
  }
  return deTexto(opts.texto ?? '')
}