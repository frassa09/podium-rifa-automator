// Captura SOMENTE-LEITURA de main.php?conteudo=form_rifa (spec 2026-10-07 §0).
//
// Uso (PowerShell):
//   $env:RIFA_CPF='...'; $env:RIFA_SENHA='...'; npm run capturar:form-rifa --workspace server
//   (opcional: $env:RIFA_TURMA='6474')
//
// Garantias:
// - Só existem 3 requisições permitidas (lista fechada em PERMITIDAS). Qualquer outra,
//   em especial /registrar_rifa.php, lança erro ANTES de sair da máquina.
// - Redirects nunca são seguidos automaticamente (redirect: 'manual').
// - Credenciais só vêm de variáveis de ambiente e nunca são impressas nem gravadas.
// - O HTML bruto (com dados pessoais) vai para server/capturas/, que está no .gitignore.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Agent } from 'undici'

const BASE = 'https://restrita.podiumeventosformaturas.com.br'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36'
const SAIDA = join(dirname(fileURLToPath(import.meta.url)), '..', 'capturas')

const PERMITIDAS = [
  { metodo: 'POST', caminho: '/' },
  { metodo: 'POST', caminho: '/autenticacao.php' },
  { metodo: 'GET', caminho: '/main.php?conteudo=form_rifa' },
] as const

// Mesmo comportamento TLS do motor atual (session.ts); ver spec §2.7.
const dispatcher = new Agent({ connect: { rejectUnauthorized: false } })

const cookies = new Map<string, string>()

function absorverCookies(headers: Headers): void {
  for (const raw of headers.getSetCookie()) {
    const par = raw.split(';')[0] ?? ''
    const eq = par.indexOf('=')
    if (eq > 0) cookies.set(par.slice(0, eq).trim(), par.slice(eq + 1).trim())
  }
}

async function req(metodo: 'GET' | 'POST', caminho: string, body?: string, extra: Record<string, string> = {}): Promise<Response> {
  if (/registrar_rifa/i.test(caminho)) throw new Error('BLOQUEADO: registrar_rifa.php é proibido neste script')
  if (!PERMITIDAS.some(p => p.metodo === metodo && p.caminho === caminho)) {
    throw new Error(`BLOQUEADO: ${metodo} ${caminho} não está na lista de requisições permitidas`)
  }
  const headers = new Headers({ 'User-Agent': UA, ...extra })
  if (metodo === 'POST') headers.set('Content-Type', 'application/x-www-form-urlencoded')
  if (cookies.size) headers.set('Cookie', [...cookies].map(([n, v]) => `${n}=${v}`).join('; '))
  const res = await fetch(BASE + caminho, {
    method: metodo,
    headers,
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(60000),
    dispatcher,
  } as RequestInit & { dispatcher: Agent })
  absorverCookies(res.headers)
  return res
}

function cabecalhosSemCookie(h: Headers): Record<string, string> {
  return Object.fromEntries([...h].filter(([k]) => k.toLowerCase() !== 'set-cookie'))
}

function texto(celula: string): string {
  return celula.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
}

// Resumo estrutural sem dados pessoais: só rótulos de coluna, contagens e valores do Nº.
function resumir(html: string) {
  const tabelas = (html.match(/<table[\s\S]*?<\/table>/gi) ?? []).map(t => {
    const linhas = t.match(/<tr[\s\S]*?<\/tr>/gi) ?? []
    const cel = (tr: string) => [...tr.matchAll(/<t[hd][\s\S]*?<\/t[hd]>/gi)].map(m => texto(m[0]))
    const rotulos = linhas.length ? cel(linhas[0]!) : []
    const iNum = rotulos.findIndex(r => /^n\s*[º°o.]?$|^n[uú]mero/i.test(r))
    const numeros = iNum < 0 ? [] : linhas.slice(1).map(l => Number(/\d+/.exec(cel(l)[iNum] ?? '')?.[0] ?? NaN)).filter(n => !Number.isNaN(n))
    const crescente = numeros.every((n, i) => i === 0 || n >= numeros[i - 1]!)
    const decrescente = numeros.every((n, i) => i === 0 || n <= numeros[i - 1]!)
    const saltos = numeros.slice(1).map((n, i) => Math.abs(n - numeros[i]!)).filter(d => d > 1)
    return {
      atributosTable: (/<table[^>]*>/i.exec(t)?.[0] ?? '').replace(/\s+/g, ' '),
      rotulos,
      linhasCorpo: Math.max(0, linhas.length - 1),
      numero: numeros.length
        ? {
            qtd: numeros.length,
            primeiro: numeros[0],
            ultimo: numeros.at(-1),
            min: Math.min(...numeros),
            max: Math.max(...numeros),
            unicos: new Set(numeros).size,
            ordem: crescente ? 'crescente' : decrescente ? 'decrescente' : 'misturada',
            saltosMaioresQue1: saltos.length,
            maiorSalto: saltos.length ? Math.max(...saltos) : 0,
          }
        : null,
    }
  })
  const indicios = (re: RegExp) => [...new Set([...html.matchAll(re)].map(m => m[0].slice(0, 120)))]
  return {
    bytes: html.length,
    formAutenticado: /<form[^>]*action=["']?[^"'>]*registrar_rifa\.php/i.test(html),
    forms: indicios(/<form[^>]*>/gi),
    tabelas,
    paginacao: indicios(/pagina=\d+|page=\d+|offset=\d+|limit[=\s]\d+|pr[oó]xima|anterior|ver mais|carregar mais|pagination|paginate/gi),
    dataTables: indicios(/datatables?[^"'\s]*|\.DataTable\s*\(|\.dataTable\s*\(/gi),
    scriptsExternos: indicios(/<script[^>]+src=["'][^"']+["']/gi),
    linksFormRifa: indicios(/href=["'][^"']*form_rifa[^"']*["']/gi),
    mensagens: indicios(/<(?:div|p|span)[^>]*class=["'][^"']*(?:alert|msg|erro|sucesso|aviso)[^"']*["'][^>]*>[\s\S]{0,160}?</gi),
    textosChave: indicios(/j[aá] cadastrad\w*|registrad\w*|sucesso|erro\w*|cpf inv[aá]lido/gi),
  }
}

async function main(): Promise<void> {
  const cpf = (process.env.RIFA_CPF ?? '').replace(/\D/g, '')
  const senha = process.env.RIFA_SENHA ?? ''
  if (!cpf || !senha) {
    console.error('Defina RIFA_CPF e RIFA_SENHA no ambiente (nunca no código nem no chat).')
    process.exit(2)
  }

  const r1 = await req('POST', '/', `usuario=${encodeURIComponent(cpf)}`, { 'X-Requested-With': 'XMLHttpRequest' })
  const turmasHtml = ((await r1.json()) as { turmas?: string }).turmas ?? ''
  const turmas = [...turmasHtml.matchAll(/value=['"](\d+)['"]/g)].map(m => m[1]!)
  const turma = process.env.RIFA_TURMA || turmas[0]
  if (!turma) throw new Error('CPF sem turmas retornadas')
  console.log(`turmas disponíveis: ${turmas.length} | usando turma ${turma}`)

  const r2 = await req('POST', '/autenticacao.php', new URLSearchParams({ usuario: cpf, turma, senha }).toString())
  const corpoLogin = await r2.text()
  const location = r2.headers.get('location') ?? ''
  console.log(`autenticacao.php → ${r2.status} location=${location || '(nenhum)'}`)
  if (corpoLogin.includes('login_falhou') || !(r2.status === 302 && /main\.php/i.test(location))) {
    throw new Error('Login não confirmado (esperado 302 → main.php). Nada foi capturado.')
  }

  const r3 = await req('GET', '/main.php?conteudo=form_rifa')
  const html = await r3.text()
  const resumo = resumir(html)

  mkdirSync(SAIDA, { recursive: true })
  const carimbo = new Date().toISOString().replace(/[:.]/g, '-')
  const arqHtml = join(SAIDA, `form_rifa.${carimbo}.html`)
  const arqMeta = join(SAIDA, `form_rifa.${carimbo}.meta.json`)
  writeFileSync(arqHtml, html, 'utf8')
  writeFileSync(arqMeta, JSON.stringify({
    capturadoEm: new Date().toISOString(),
    turma,
    login: { status: r2.status, location, headers: cabecalhosSemCookie(r2.headers) },
    formRifa: { status: r3.status, location: r3.headers.get('location'), headers: cabecalhosSemCookie(r3.headers) },
    resumo,
  }, null, 2), 'utf8')

  console.log(`form_rifa → ${r3.status} | ${resumo.bytes} bytes | form autenticado: ${resumo.formAutenticado}`)
  console.log(JSON.stringify(resumo, null, 2))
  console.log(`\nHTML bruto (contém dados pessoais, NÃO commitar): ${arqHtml}`)
  console.log(`Metadados: ${arqMeta}`)
  if (!resumo.formAutenticado) process.exitCode = 1
}

main().catch(e => {
  console.error(`Falhou: ${(e as Error).message}`)
  process.exit(1)
})
