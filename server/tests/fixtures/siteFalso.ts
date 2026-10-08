import { createServer, type Server } from 'node:http'
import { emLatin1, htmlFormRifa, rifa, type RifaFixture } from './formRifa.ts'

// Site da Podium simulado, com estado: cada POST em /registrar_rifa.php cria uma linha na
// tabela. O Nº vem de uma sequência compartilhada com outras contas (pula números), como no real.
export interface SiteFalso {
  base: string
  rifas: RifaFixture[]
  posts: string[] // corpos crus (latin1) recebidos em /registrar_rifa.php
  // Comportamentos de falha controlados pelo teste:
  postsIgnorados: number // próximos N POSTs não criam nada
  esconderRecentes: number // as N rifas mais novas não aparecem na tabela (site "atrasado")
  derrubarRespostaPost: boolean // cria a rifa mas derruba a conexão sem responder
  paginaQuebrada: boolean // form_rifa sem a tabela
  fechar: () => Promise<void>
}

function cpfMascarado(corpoLatin1: string): string {
  const m = /campos%5Bcpf%5D=([^&]*)/.exec(corpoLatin1)
  return decodeURIComponent(m?.[1] ?? '')
}

function nomeDoPost(corpoLatin1: string): string {
  const m = /campos%5Bnome%5D=([^&]*)/.exec(corpoLatin1)
  const bytes = (m?.[1] ?? '').replace(/\+/g, ' ').replace(/%([0-9A-F]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
  return bytes
}

export async function criarSiteFalso(iniciais: RifaFixture[] = []): Promise<SiteFalso> {
  let proximo = 1003
  for (const r of iniciais) proximo = Math.max(proximo, Number(r.numero) + 1)
  const estado: Omit<SiteFalso, 'base' | 'fechar'> = {
    rifas: [...iniciais],
    posts: [],
    postsIgnorados: 0,
    esconderRecentes: 0,
    derrubarRespostaPost: false,
    paginaQuebrada: false,
  }

  const srv: Server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://localhost')
    const partes: Buffer[] = []
    req.on('data', c => partes.push(c as Buffer))
    req.on('end', () => {
      const corpo = Buffer.concat(partes).toString('latin1')
      const html = (s: string) => {
        res.setHeader('Content-Type', 'text/html; charset=iso-8859-1')
        res.end(emLatin1(s))
      }
      if (u.pathname === '/' && req.method === 'POST') {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ turmas: '<option value="6474">Turma</option>' }))
        return
      }
      if (u.pathname === '/autenticacao.php') {
        if (corpo.includes('errada')) {
          html('login_falhou')
          return
        }
        res.setHeader('Set-Cookie', 'PHPSESSID=abc123; path=/')
        res.statusCode = 302
        res.setHeader('Location', '/main.php?conteudo=principal')
        res.end()
        return
      }
      if (u.pathname === '/main.php') {
        const visiveis = estado.rifas.slice(0, estado.rifas.length - estado.esconderRecentes)
        html(htmlFormRifa(visiveis, { semTabela: estado.paginaQuebrada }))
        return
      }
      if (u.pathname === '/registrar_rifa.php') {
        estado.posts.push(corpo)
        if (estado.postsIgnorados > 0) {
          estado.postsIgnorados--
        } else {
          proximo += 1 + (estado.posts.length % 3) // outras contas usam números no meio
          estado.rifas.push(rifa(proximo, cpfMascarado(corpo), nomeDoPost(corpo)))
          proximo++
        }
        if (estado.derrubarRespostaPost) {
          req.socket.destroy()
          return
        }
        res.statusCode = 302
        res.setHeader('Location', '/main.php?conteudo=form_rifa')
        res.end()
        return
      }
      res.statusCode = 404
      res.end('not found')
    })
  })
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r))
  const porta = (srv.address() as { port: number }).port
  const site = estado as SiteFalso
  site.base = `http://127.0.0.1:${porta}`
  site.fechar = () => new Promise(r => srv.close(() => r()))
  return site
}
