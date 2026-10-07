// Gera server/tests/fixtures/form_rifa.real.html a partir de uma captura real
// (scripts/capturarFormRifa.ts), trocando todo dado pessoal por fictício.
//
// Uso: npx tsx scripts/anonimizarFormRifa.ts capturas/form_rifa.<carimbo>.html
//
// Preserva o que importa para os testes: estrutura, Nº (com saltos), Ano, Tipo, Data,
// e a distribuição de rifas por comprador (mesmo CPF real → mesmo CPF fictício).
// Falha se qualquer valor original sobrar no resultado.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DESTINO = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'form_rifa.real.html')

function cpfFicticio(i: number): string {
  const base = String(900000000 + i).padStart(9, '0').split('').map(Number)
  const dv = (ds: number[]) => {
    const r = (ds.reduce((s, d, k) => s + d * (ds.length + 1 - k), 0) * 10) % 11
    return r === 10 ? 0 : r
  }
  const d1 = dv(base)
  const d2 = dv([...base, d1])
  const s = [...base, d1, d2].join('')
  return `${s.slice(0, 3)}.${s.slice(3, 6)}.${s.slice(6, 9)}-${s.slice(9)}`
}

const nn = (i: number) => String(i).padStart(2, '0')

function main(): void {
  const origem = process.argv[2]
  if (!origem) throw new Error('Informe o caminho da captura')
  let html = readFileSync(origem, 'utf8')
  const originais = new Set<string>()

  // Linhas da tabela
  const cpfs = new Map<string, number>()
  const telefones = new Map<string, string>()
  let linhas = 0
  html = html.replace(/<tbody>[\s\S]*?<\/tbody>/, tbody =>
    tbody.replace(/<tr[\s\S]*?<\/tr>/g, tr => {
      linhas++
      const cel = (titulo: string) => {
        const m = new RegExp(`data-title="${titulo}">([^<]*)</td>`).exec(tr)
        if (!m) throw new Error(`Coluna ${titulo} ausente na linha ${linhas}`)
        return m[1]!
      }
      const nome = cel('Nome')
      const cpf = cel('CPF')
      const email = cel('E-mail')
      const tel = cel('Telefone')
      for (const v of [nome.trim(), cpf, cpf.replace(/\D/g, ''), email, tel, tel.replace(/\D/g, '')]) if (v) originais.add(v)
      if (!cpfs.has(cpf)) cpfs.set(cpf, cpfs.size + 1)
      const i = cpfs.get(cpf)!
      if (!telefones.has(tel)) telefones.set(tel, `(11) 90000-${String(telefones.size + 1).padStart(4, '0')}`)
      const espacoFinal = /\s*$/.exec(nome)?.[0] ?? ''
      return tr
        .replace(`data-title="Nome">${nome}<`, `data-title="Nome">Comprador Ficticio ${nn(i)}${espacoFinal}<`)
        .replace(`data-title="CPF">${cpf}<`, `data-title="CPF">${cpfFicticio(i)}<`)
        .replace(`data-title="E-mail">${email}<`, `data-title="E-mail">comprador${nn(i)}@exemplo.com.br<`)
        .replace(`data-title="Telefone">${tel}<`, `data-title="Telefone">${telefones.get(tel)}<`)
    }),
  )

  // Vendedor (cabeçalho + fieldset "Dados do Vendedor"). Depois da tabela: um comprador
  // pode usar o e-mail do vendedor, e a troca global mascararia o original da linha.
  const vendedor = /class="username">\s*<a[^>]*>\s*([^<]+?)\s*<\/a>/.exec(html)?.[1]
  const fieldset = /Dados do Vendedor<\/legend>([\s\S]*?)<\/fieldset>/.exec(html)?.[1] ?? ''
  const emailVendedor = /type="email" value="([^"]+)"/.exec(fieldset)?.[1]
  if (!vendedor || !emailVendedor) throw new Error('Dados do vendedor não encontrados')
  originais.add(vendedor).add(emailVendedor)
  html = html.replaceAll(vendedor, 'Vendedor Ficticio da Silva').replaceAll(emailVendedor, 'vendedor@exemplo.com.br')

  const orcamento = /Or\S*amento #(\d+)/.exec(html)?.[1]
  if (orcamento) {
    originais.add(orcamento)
    html = html.replace(`#${orcamento}`, '#99999')
  }

  // Verificação: nenhum valor original pode sobrar (ignora pedaços curtos demais).
  const sobras = [...originais].filter(v => v.length >= 5 && html.includes(v))
  const emailsReais = [...html.matchAll(/[\w.+-]+@[\w-]+\.[\w.]+/g)].map(m => m[0]).filter(e => !e.endsWith('@exemplo.com.br'))
  if (sobras.length || emailsReais.length) {
    throw new Error(`Anonimização incompleta: ${sobras.length} valores originais e ${emailsReais.length} e-mails restantes`)
  }

  mkdirSync(dirname(DESTINO), { recursive: true })
  writeFileSync(DESTINO, html, 'utf8')
  console.log(`${linhas} linhas, ${cpfs.size} compradores distintos → ${DESTINO}`)
}

main()
