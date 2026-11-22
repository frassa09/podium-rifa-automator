import { apenasDigitos } from '../utils/cpf.ts'

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
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[º°]/g, 'o').toLowerCase().trim()

const CPF_MASCARADO = /^\d{3}\.\d{3}\.\d{3}-\d{2}$/

// Layout de 2026-11 (site redesenhado): lista "Suas vendas" em cartões.
//   <section class="panel" aria-labelledby="h-vendas">
//     <h2 class="sec" id="h-vendas">Suas vendas</h2>
//     <div class="rows">
//       <div class="row" ...>
//         <div><b>NOME</b><div class="muted small" ...>CPF · TELEFONE · EMAIL · TIPO</div></div>
//         <div style="text-align:right"><b>Nº 0001234</b><div class="muted small">dd/mm/aaaa hh:mm</div></div>
//       </div>
//     ...
function parseLista(html: string): RifaSite[] | null {
  const ini = html.search(/<section[^>]*aria-labelledby=["']h-vendas["'][^>]*>/i)
  if (ini < 0) return null
  const fim = html.indexOf('</section>', ini)
  if (fim < 0) throw new Error('Lista de vendas sem fechamento (</section>)')
  const secao = html.slice(ini, fim)

  const blocos = secao.split(/<div[^>]*class=["']row["'][^>]*>/i).slice(1)
  const rifas: RifaSite[] = []
  for (const bloco of blocos) {
    const numeros = [...bloco.matchAll(/<b>\s*N[º°o]\s*(\d+)\s*<\/b>/gi)]
    if (numeros.length !== 1) throw new Error(`Cartão de venda com ${numeros.length} "Nº" (esperado 1)`)
    const numero = numeros[0]![1]!
    const detalhe = /<div[^>]*class=["'][^"']*muted[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(bloco)?.[1]
    if (detalhe === undefined) throw new Error(`Cartão de venda Nº ${numero} sem linha de detalhes`)
    const cpfTxt = textoCelula(detalhe).split('·')[0]!.trim()
    if (!CPF_MASCARADO.test(cpfTxt)) throw new Error(`CPF inesperado no cartão de venda Nº ${numero}`)
    rifas.push({ numero, cpf: apenasDigitos(cpfTxt) })
  }
  // Defesa extra: todo "Nº" da seção precisa ter virado uma rifa lida.
  const totalNs = (secao.match(/<b>\s*N[º°o]\s*\d+\s*<\/b>/gi) ?? []).length
  if (totalNs !== rifas.length) throw new Error(`Lista de vendas inconsistente: ${totalNs} Nº para ${rifas.length} cartões`)
  if (rifas.length === 0 && /N�/.test(secao)) throw new Error('Página decodificada com charset errado')
  return rifas
}

// Layout antigo (até 2026-11): <table id="imoveis"> com thead/tbody. Mantido caso o site volte.
function parseTabela(html: string): RifaSite[] | null {
  const tabela = /<table[^>]*id=["']imoveis["'][^>]*>([\s\S]*?)<\/table>/i.exec(html)?.[1]
  if (!tabela) return null
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

// Lê as rifas da conta. Qualquer desvio do formato conhecido LANÇA erro:
// nunca devolve lista vazia "por não achar", pois isso faria o motor achar que nada foi criado.
export function parseRifas(html: string): RifaSite[] {
  if (!/<form[^>]*action=["']?[^"'>]*registrar_rifa\.php/i.test(html)) {
    throw new Error('Página não é o formulário autenticado de rifas (sessão expirada?)')
  }
  const lista = parseLista(html)
  if (lista) return lista
  const tabela = parseTabela(html)
  if (tabela) return tabela
  throw new Error('Lista de rifas não encontrada na página (layout do site mudou?)')
}
