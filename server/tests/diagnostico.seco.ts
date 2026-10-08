// Diagnóstico SOMENTE LEITURA do site (nunca envia rifa).
// Executar na raiz: node --env-file=.env --import tsx server/tests/diagnostico.seco.ts
// Salva o HTML bruto em DIAG_DIR (fora do repo) e imprime só a estrutura, sem dados de compradores.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PodiumSession } from '../src/podium/session.ts'

const limpar = (s: string) => s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()

async function main() {
  const cpf = process.env.RIFA_CPF
  const senha = process.env.RIFA_SENHA
  if (!cpf || !senha) throw new Error('Defina RIFA_CPF e RIFA_SENHA no .env')
  const s = await PodiumSession.login(cpf, senha)
  console.log('Login OK. Turma:', s.turma)

  const res = await s.getPage('/main.php?conteudo=form_rifa')
  const bytes = Buffer.from(await res.arrayBuffer())
  const dir = process.env.DIAG_DIR ?? '.'
  writeFileSync(join(dir, 'form_rifa.html'), bytes)
  const html = bytes.toString('latin1')

  console.log('HTTP', res.status, '| content-type:', res.headers.get('content-type'))
  console.log('meta charset:', /<meta[^>]+charset=["']?([\w-]+)/i.exec(html)?.[1] ?? '(nenhum)')
  console.log('bytes UTF-8 multibyte presentes:', /[\xC3][\x80-\xBF]/.test(html))

  for (const f of html.match(/<form[\s\S]*?<\/form>/gi) ?? []) {
    console.log('\nFORM:', /<form[^>]*>/i.exec(f)?.[0])
    for (const c of f.match(/<(input|select|textarea|button)[^>]*>/gi) ?? []) {
      const nome = /name=["']?([^"'\s>]+)/i.exec(c)?.[1]
      const tipo = /type=["']?([^"'\s>]+)/i.exec(c)?.[1] ?? c.slice(1, c.indexOf(' ') > 0 ? c.indexOf(' ') : undefined)
      const valor = /value=["']?([^"'>]*)/i.exec(c)?.[1]
      const extra = [/maxlength=["']?\d+/i, /required/i, /pattern=["'][^"']*["']/i].map(r => r.exec(c)?.[0]).filter(Boolean)
      console.log(`  ${tipo} name=${nome}${tipo === 'hidden' || tipo === 'submit' ? ` value=${valor}` : ''} ${extra.join(' ')}`)
    }
  }

  const tabelas = html.match(/<table[\s\S]*?<\/table>/gi) ?? []
  console.log('\nTabelas:', tabelas.length)
  tabelas.forEach((t, i) => {
    const linhas = t.match(/<tr[\s\S]*?<\/tr>/gi) ?? []
    const cab = [...(linhas[0] ?? '').matchAll(/<t[hd][\s\S]*?<\/t[hd]>/gi)].map(m => limpar(m[0]))
    console.log(`  #${i}: ${linhas.length} <tr> | cabeçalho: ${JSON.stringify(cab)}`)
    const nos = linhas.slice(1).map(l => limpar(/<t[hd][\s\S]*?<\/t[hd]>/i.exec(l)?.[0] ?? ''))
    console.log(`     1ª coluna (primeiras 5): ${JSON.stringify(nos.slice(0, 5))} … (últimas 5): ${JSON.stringify(nos.slice(-5))}`)
    const tipos = linhas.slice(1, 4).map(l => [...l.matchAll(/<t[hd][\s\S]*?<\/t[hd]>/gi)].map(m => limpar(m[0]).replace(/[A-Za-zÀ-ÿ]/g, 'a').replace(/\d/g, '9')))
    console.log(`     formato das 3 primeiras linhas (letras→a, dígitos→9): ${JSON.stringify(tipos)}`)
  })
  console.log('\nPaginação/limite?', /pagina|página|próxima|proxima|limit|offset|page=/i.test(html))
  console.log('Scripts inline que mexem no form:', (html.match(/<script[\s\S]*?<\/script>/gi) ?? []).filter(x => /rifa|submit|campos/i.test(x)).length)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
