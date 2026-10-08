import { Agent } from 'undici'
import { maskCPF, apenasDigitos } from '../utils/cpf.ts'
import { maskPhone } from '../utils/masks.ts'
import type { Pessoa } from '../types.ts'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36'

const dispatcher = new Agent({ connect: { rejectUnauthorized: false } })

const TIMEOUT = 30000

// O site é PHP em ISO-8859-1. Decodificar como UTF-8 transforma o "º" de "Nº" em "�"
// e a tabela deixa de ser reconhecida — foi o que fez o motor reenviar rifas.
const decodificador = new TextDecoder('latin1')

export async function lerTexto(res: Response): Promise<string> {
  return decodificador.decode(await res.arrayBuffer())
}

// Corpo application/x-www-form-urlencoded em ISO-8859-1, como o navegador envia nesse site.
export function codificarFormLatin1(campos: Record<string, string>): string {
  const cod = (v: string): string => {
    let out = ''
    for (const ch of v.normalize('NFC')) {
      const c = ch.codePointAt(0)!
      if (c > 0xff) throw new Error(`Caractere "${ch}" não é aceito pelo site (fora de ISO-8859-1)`)
      if (/[A-Za-z0-9*\-._]/.test(ch)) out += ch
      else if (ch === ' ') out += '+'
      else out += '%' + c.toString(16).toUpperCase().padStart(2, '0')
    }
    return out
  }
  return Object.entries(campos).map(([k, v]) => `${cod(k)}=${cod(v)}`).join('&')
}

export interface RifaSite {
  numero: string
  cpf: string
}

const textoCelula = (html: string): string =>
  html
    .replace(/<span[^>]*display:\s*none[^>]*>[\s\S]*?<\/span>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const normalizarRotulo = (s: string): string =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[º°]/g, 'o').toLowerCase().trim()

// Lê a tabela de rifas da conta. Qualquer desvio do formato conhecido LANÇA erro:
// nunca devolve lista vazia "por não achar", pois isso faria o motor achar que nada foi criado.
export function parseRifas(html: string): RifaSite[] {
  if (!/<form[^>]*action=["']?[^"'>]*registrar_rifa\.php/i.test(html)) {
    throw new Error('Página não é o formulário autenticado de rifas (sessão expirada?)')
  }
  const tabela = /<table[^>]*id=["']imoveis["'][^>]*>([\s\S]*?)<\/table>/i.exec(html)?.[1]
  if (!tabela) throw new Error('Tabela de rifas (#imoveis) não encontrada na página')
  const thead = /<thead[^>]*>([\s\S]*?)<\/thead>/i.exec(tabela)?.[1]
  const tbody = /<tbody[^>]*>([\s\S]*?)<\/tbody>/i.exec(tabela)?.[1]
  if (thead === undefined || tbody === undefined) throw new Error('Tabela de rifas sem thead/tbody')

  const cab = [...thead.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map(m => normalizarRotulo(textoCelula(m[1]!)))
  const iNum = cab.indexOf('no')
  const iCpf = cab.indexOf('cpf')
  if (iNum < 0 || iCpf < 0) throw new Error(`Cabeçalho da tabela de rifas mudou: ${JSON.stringify(cab)}`)

  const rifas: RifaSite[] = []
  for (const tr of tbody.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) ?? []) {
    const tds = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => textoCelula(m[1]!))
    // Linha "nenhum registro" do DataTables (célula única com colspan).
    if (tds.length === 1 && /colspan/i.test(tr)) continue
    if (tds.length !== cab.length) throw new Error(`Linha da tabela com ${tds.length} colunas (esperado ${cab.length})`)
    const numero = tds[iNum]!
    const cpf = apenasDigitos(tds[iCpf]!)
    if (!/^\d+$/.test(numero)) throw new Error(`Nº inesperado na tabela: "${numero}"`)
    if (cpf.length !== 11) throw new Error(`CPF inesperado na tabela (Nº ${numero})`)
    rifas.push({ numero, cpf })
  }
  return rifas
}

export class ErroLogin extends Error {
  motivo: 'cpf' | 'credencial' | 'rede'
  constructor(motivo: ErroLogin['motivo'], msg: string) {
    super(msg)
    this.motivo = motivo
    this.name = 'ErroLogin'
  }
}

interface Cookie {
  nome: string
  valor: string
}

export class PodiumSession {
  private cookies: Cookie[] = []
  private baseUrl: string
  private _turma = ''

  private constructor(baseUrl: string) {
    this.baseUrl = baseUrl
  }

  get cookieHead(): string {
    return this.cookies.map(c => `${c.nome}=${c.valor}`).join('; ')
  }

  get turma(): string {
    return this._turma
  }

  private absorverCookies(headers: Headers): void {
    const comGetSetCookie = headers as Headers & { getSetCookie?: () => string[] }
    const sets = comGetSetCookie.getSetCookie?.() ?? [headers.get('set-cookie')].filter(Boolean) as string[]
    for (const raw of sets) {
      const [par] = raw.split(';')
      if (!par) continue
      const eq = par.indexOf('=')
      if (eq < 0) continue
      const nome = par.slice(0, eq).trim()
      const valor = par.slice(eq + 1).trim()
      const existe = this.cookies.find(c => c.nome === nome)
      if (existe) existe.valor = valor
      else this.cookies.push({ nome, valor })
    }
  }

  private async req(path: string, init: RequestInit = {}, segue302 = true): Promise<Response> {
    const url = this.baseUrl + path
    const headers = new Headers(init.headers)
    headers.set('User-Agent', UA)
    if (init.method === 'POST' && !headers.has('Content-Type')) headers.set('Content-Type', 'application/x-www-form-urlencoded')
    if (this.cookies.length) headers.set('Cookie', this.cookieHead)
    const res = await globalThis.fetch(url, {
      ...init,
      headers,
      dispatcher,
      redirect: segue302 ? 'follow' : 'manual',
      signal: AbortSignal.timeout(TIMEOUT),
    } as RequestInit & { dispatcher: typeof dispatcher })
    this.absorverCookies(res.headers)
    return res
  }

  static async login(cpf: string, senha: string, opts: { baseUrl?: string } = {}): Promise<PodiumSession> {
    const base = opts.baseUrl ?? 'https://restrita.podiumeventosformaturas.com.br'
    const s = new PodiumSession(base)
    try {
      const r1 = await s.req('/', {
        method: 'POST',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
        body: `usuario=${encodeURIComponent(apenasDigitos(cpf))}`,
      })
      const json = (await r1.json()) as { turmas?: string }
      const turmas = json.turmas ?? ''
      const m = /value=['"](\d+)['"]/.exec(turmas)
      if (!m?.[1]) throw new ErroLogin('cpf', 'CPF não encontrado (turmas não retornadas)')
      const turma = m[1]
      s._turma = turma

      const r3 = await s.req('/autenticacao.php', {
        method: 'POST',
        body: new URLSearchParams({ usuario: apenasDigitos(cpf), turma, senha }).toString(),
      }, false)
      if (!r3.ok && r3.status !== 302) {
        // login_falhou vem com 200; detecta pelo corpo
        const corpo = await r3.text()
        if (corpo.includes('login_falhou')) throw new ErroLogin('credencial', 'Credencial inválida')
      }
      if (!s.cookieHead.includes('PHPSESSID')) {
        throw new ErroLogin('credencial', 'Credencial inválida (sem sessão)')
      }
      return s
    } catch (e) {
      if (e instanceof ErroLogin) throw e
      throw new ErroLogin('rede', `Falha de rede: ${(e as Error).message}`)
    }
  }

  async getPage(path: string): Promise<Response> {
    return this.req(path)
  }

  async submeterRifa(p: Pessoa): Promise<void> {
    const body = codificarFormLatin1({
      'campos[nome]': p.nome.trim(),
      'campos[cpf]': maskCPF(p.cpf),
      'campos[telefone]': maskPhone(p.telefone),
      'campos[email]': p.email.trim(),
      enviar: 'Enviar',
    })
    const res = await this.req('/registrar_rifa.php', {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=ISO-8859-1' },
    })
    await res.arrayBuffer()
  }

  async lerRifas(): Promise<RifaSite[]> {
    const res = await this.req('/main.php?conteudo=form_rifa')
    if (!res.ok) throw new Error(`Página de rifas respondeu HTTP ${res.status}`)
    return parseRifas(await lerTexto(res))
  }

  async checarSessao(): Promise<boolean> {
    const res = await this.req('/main.php?conteudo=principal')
    const html = await lerTexto(res)
    return html.includes('Logout') || html.includes('form_rifa')
  }
}