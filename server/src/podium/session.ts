import { Agent } from 'undici'
import { maskCPF, apenasDigitos } from '../utils/cpf.ts'
import { maskPhone } from '../utils/masks.ts'
import type { Pessoa } from '../types.ts'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36'

const dispatcher = new Agent({ connect: { rejectUnauthorized: false } })

const TIMEOUT = 30000

const ROTULOS_NUMERO = new Set(['n', 'no', 'num', 'numeros', 'nro', 'numero', 'numero da rifa', 'num da rifa', 'rifa'])

export function parseNumeroMaximo(html: string): number {
  if (!/<form[^>]*action=["']?[^"'>]*registrar_rifa\.php/i.test(html)) {
    throw new Error('Página não é o formulário autenticado de rifas (sessão expirada?)')
  }
  const tabelas = html.match(/<table[\s\S]*?<\/table>/gi) ?? []
  let maior = 0
  for (const tabela of tabelas) {
    const linhas = tabela.match(/<tr[\s\S]*?<\/tr>/gi) ?? []
    for (let li = 0; li < linhas.length; li++) {
      const celulas = [...(linhas[li]!.matchAll(/<t(?:h|d)[\s\S]*?<\/t(?:h|d)>/gi))].map(m => m[0]!)
      for (let ci = 0; ci < celulas.length; ci++) {
        const rotulo = celulas[ci]!
          .replace(/<[^>]*>/g, '')
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .toLowerCase()
          .replace(/[º°]/g, '')
          .trim()
        if (!ROTULOS_NUMERO.has(rotulo)) continue
        for (let r = li + 1; r < linhas.length; r++) {
          const celulasCorpo = [...(linhas[r]!.matchAll(/<t(?:h|d)[\s\S]*?<\/t(?:h|d)>/gi))].map(m => m[0]!)
          const celula = celulasCorpo[ci]
          if (!celula) continue
          const num = /(\d+)/.exec(celula.replace(/<[^>]*>/g, '').trim())
          if (num) maior = Math.max(maior, Number(num[0]))
        }
      }
    }
  }
  return maior
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
    const body = new URLSearchParams({
      'campos[nome]': p.nome,
      'campos[cpf]': maskCPF(p.cpf),
      'campos[telefone]': maskPhone(p.telefone),
      'campos[email]': p.email,
      enviar: 'Enviar',
    }).toString()
    await this.req('/registrar_rifa.php', { method: 'POST', body })
  }

  async lerMaiorNumero(): Promise<number> {
    const res = await this.req('/main.php?conteudo=form_rifa')
    const html = await res.text()
    return parseNumeroMaximo(html)
  }

  async checarSessao(): Promise<boolean> {
    const res = await this.req('/main.php?conteudo=principal')
    const html = await res.text()
    return html.includes('Logout') || html.includes('form_rifa')
  }
}