// Simulador HTTP da Podium para testes de integridade (spec 2026-10-07 §3).
// Serve a fixture real anonimizada com o mesmo Content-Type do site (ISO-8859-1)
// e cria rifas de verdade no estado interno a cada POST em /registrar_rifa.php.
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'form_rifa.real.html')

export interface OpcoesSiteFalso {
  // Estado da tabela "no momento" do cenário: só linhas da fixture com Nº menor que este,
  // e o próximo Nº global será este.
  proximoNumero: number
  // Rifas de outros vendedores criadas entre dois envios desta conta (saltos do Nº global).
  outrosVendedoresPorEnvio?: number
  // Só para teste de controle: o site real usa ISO-8859-1.
  codificacao?: 'latin1' | 'utf8'
  // Demora do site para responder ao registro (a rifa já foi criada).
  atrasoPostMs?: number
}

export interface PostRegistrar {
  numero: number
  campos: Record<string, string>
}

export interface SiteFalso {
  baseUrl: string
  posts: PostRegistrar[]
  fechar: () => Promise<void>
}

const celula = (titulo: string, valor: string) => `                <td data-title="${titulo}">${valor}</td>\n`

export async function iniciarSiteFalso(opts: OpcoesSiteFalso): Promise<SiteFalso> {
  // A fixture foi salva já decodificada como UTF-8, então os bytes Latin-1 viraram U+FFFD.
  // Restauramos o rótulo da coluna (o que importa para o motor); os demais acentos não importam aqui.
  const html = readFileSync(FIXTURE, 'utf8').replaceAll('N�', 'Nº')
  const iBody = html.indexOf('<tbody>') + '<tbody>'.length
  const fBody = html.indexOf('</tbody>')
  const antes = html.slice(0, iBody)
  const depois = html.slice(fBody)
  const linhas = (html.slice(iBody, fBody).match(/<tr[\s\S]*?<\/tr>/g) ?? [])
    .filter(tr => Number(/>(\d+)<\/td>/.exec(tr)?.[1]) < opts.proximoNumero)

  let proximo = opts.proximoNumero
  const posts: PostRegistrar[] = []

  const cod = opts.codificacao ?? 'latin1'
  const renderizar = () => Buffer.from(`${antes}\n${linhas.join('\n')}\n            ${depois}`, cod)

  const srv: Server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://localhost')
    const partes: Buffer[] = []
    req.on('data', c => partes.push(c))
    req.on('end', () => {
      const corpo = Buffer.concat(partes).toString('utf8')
      if (u.pathname === '/' && req.method === 'POST') {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ turmas: '<option value="">Selecione</option><option value="6474">Turma</option>' }))
        return
      }
      if (u.pathname === '/autenticacao.php' && req.method === 'POST') {
        res.setHeader('Set-Cookie', 'PHPSESSID=sessaofalsa; path=/')
        res.writeHead(302, { Location: 'main.php?conteudo=principal' }).end()
        return
      }
      if (u.pathname === '/main.php' && req.method === 'GET') {
        res.setHeader('Content-Type', `text/html; charset=${cod === 'latin1' ? 'ISO-8859-1' : 'UTF-8'}`)
        res.end(u.searchParams.get('conteudo') === 'form_rifa' ? renderizar() : Buffer.from('<a href="logoff.php">Logout</a> form_rifa', 'latin1'))
        return
      }
      if (u.pathname === '/registrar_rifa.php' && req.method === 'POST') {
        const campos = Object.fromEntries(new URLSearchParams(corpo))
        const numero = proximo
        posts.push({ numero, campos })
        linhas.push(
          '<tr align="center">\n' +
            celula('Nº', String(numero).padStart(7, '0')) +
            celula('Nome', campos['campos[nome]'] ?? '') +
            celula('CPF', campos['campos[cpf]'] ?? '') +
            celula('E-mail', campos['campos[email]'] ?? '') +
            celula('Telefone', campos['campos[telefone]'] ?? '') +
            celula('Ano', '2026') +
            celula('Tipo', 'Ensino Médio') +
            celula('Data', '<span style="display: none;">2026-09-15 17:15:01</span>15/09/2026 17:15') +
            '            </tr>',
        )
        proximo += 1 + (opts.outrosVendedoresPorEnvio ?? 0)
        // §0.5: resposta do registro NÃO verificada no site real; assumido o padrão do login.
        setTimeout(() => res.writeHead(302, { Location: 'main.php?conteudo=form_rifa' }).end(), opts.atrasoPostMs ?? 0)
        return
      }
      res.writeHead(404).end()
    })
  })
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r))
  const { port } = srv.address() as { port: number }
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    posts,
    fechar: () => new Promise(r => srv.close(() => r())),
  }
}
