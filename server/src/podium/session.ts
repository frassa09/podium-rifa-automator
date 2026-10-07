import { Agent } from 'undici'
import { maskCPF, apenasDigitos } from '../utils/cpf.ts'
import { maskPhone } from '../utils/masks.ts'
import type { Pessoa } from '../types.ts'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36'

const dispatcher = new Agent({ connect: { rejectUnauthorized: false } })

const TIMEOUT = 30000

const ROTULOS_NUMERO = new Set(['n', 'no', 'num', 'nro', 'numero'])

export interface RifaNaTabela {
  numero: number
  cpf: string
}

const textoCelula = (c: string): string =>
  c.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim()

const celulas = (tr: string): string[] =>
  [...tr.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map(m => textoCelula(m[1]!))

// Rótulo só com letras ASCII: "Nº", "N°" e "N�" (Latin-1 lido como UTF-8) viram "n".
const rotulo = (s: string): string =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z ]/g, '').trim()

// Lê a tabela #imoveis INTEIRA de form_rifa (§0: o servidor manda todas as linhas da conta;
// a paginação do DataTables é só no navegador). Qualquer coisa fora do formato esperado
// lança erro — nunca devolve lista parcial nem vazia por padrão (spec 2026-10-07 §2.1).
export function parseRifasDaTabela(html: string): RifaNaTabela[] {
  if (!/<form[^>]*action=["']?[^"'>]*registrar_rifa\.php/i.test(html)) {
    throw new Error('Página não é o formulário autenticado de rifas (sessão expirada?)')
  }
  const tabela = /<table[^>]*id=["']imoveis["'][^>]*>([\s\S]*?)<\/table>/i.exec(html)?.[1]
  const thead = tabela && /<thead[^>]*>([\s\S]*?)<\/thead>/i.exec(tabela)?.[1]
  const tbody = tabela && /<tbody[^>]*>([\s\S]*?)<\/tbody>/i.exec(tabela)?.[1]
  if (thead == null || tbody == null) throw new Error('Tabela de rifas (#imoveis) não encontrada ou incompleta')
  const rotulos = celulas(thead).map(rotulo)
  const iNum = rotulos.findIndex(r => ROTULOS_NUMERO.has(r))
  const iCpf = rotulos.indexOf('cpf')
  if (iNum < 0 || iCpf < 0) throw new Error(`Colunas Nº/CPF não encontradas na tabela (${rotulos.join(', ')})`)
  return (tbody.match(/<tr[\s\S]*?<\/tr>/gi) ?? []).map((tr, i) => {
    const cs = celulas(tr)
    const numero = cs[iNum] ?? ''
    const cpf = apenasDigitos(cs[iCpf] ?? '')
    if (cs.length !== rotulos.length || !/^\d+$/.test(numero) || cpf.length !== 11) {
      throw new Error(`Linha ${i + 1} da tabela de rifas fora do formato esperado`)
    }
    return { numero: Number(numero), cpf }
  })
}

export function contarRifasDoCpf(rifas: RifaNaTabela[], cpf: string): number {
  const alvo = apenasDigitos(cpf)
  return rifas.filter(r => r.cpf === alvo).length
}

export interface RespostaRegistro {
  status: number
  location: string
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
    if (init.method === 'POST') headers.set('Content-Type', 'application/x-www-form-urlencoded')
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
      // Só 302 → main.php é sucesso. Observado no site real (§0): senha errada responde
      // 302 → index.php?msg=invalido; versões antigas respondiam 200 com "login_falhou".
      // O PHPSESSID já existe desde o 1º POST, então não prova nada.
      const location = r3.headers.get('location') ?? ''
      const corpo = await r3.text()
      if (r3.status !== 302 || !/main\.php/i.test(location)) {
        const motivo = /msg=([\w-]+)/.exec(location)?.[1] ?? (corpo.includes('login_falhou') ? 'login_falhou' : `HTTP ${r3.status}`)
        throw new ErroLogin('credencial', `Credencial inválida (${motivo})`)
      }
      // Exige o formulário autenticado com a tabela legível antes de declarar a sessão pronta.
      try {
        await s.lerRifas()
      } catch (e) {
        throw new ErroLogin('rede', `Login aceito, mas a página de rifas não abriu: ${(e as Error).message}`)
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

  // Um único POST, sem seguir redirect: o timeout cobre só o envio, não o GET da tabela.
  // A resposta não decide nada; só a medição pela tabela confirma (§2.2.e).
  async submeterRifa(p: Pessoa): Promise<RespostaRegistro> {
    const body = new URLSearchParams({
      'campos[nome]': p.nome,
      'campos[cpf]': maskCPF(p.cpf),
      'campos[telefone]': maskPhone(p.telefone),
      'campos[email]': p.email,
      enviar: 'Enviar',
    }).toString()
    const res = await this.req('/registrar_rifa.php', { method: 'POST', body }, false)
    await res.body?.cancel()
    return { status: res.status, location: res.headers.get('location') ?? '' }
  }

  // O site responde ISO-8859-1; Response.text() sempre decodifica UTF-8 (§0).
  private static async lerHtml(res: Response): Promise<string> {
    const charset = /charset=([\w-]+)/i.exec(res.headers.get('content-type') ?? '')?.[1] ?? 'iso-8859-1'
    return new TextDecoder(charset).decode(await res.arrayBuffer())
  }

  async lerRifas(): Promise<RifaNaTabela[]> {
    const res = await this.req('/main.php?conteudo=form_rifa')
    if (res.status !== 200) throw new Error(`form_rifa respondeu ${res.status}`)
    return parseRifasDaTabela(await PodiumSession.lerHtml(res))
  }

  async contarRifasDoCpf(cpf: string): Promise<number> {
    return contarRifasDoCpf(await this.lerRifas(), cpf)
  }

  async checarSessao(): Promise<boolean> {
    const res = await this.req('/main.php?conteudo=principal')
    const html = await res.text()
    return html.includes('Logout') || html.includes('form_rifa')
  }
}