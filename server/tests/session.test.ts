import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { PodiumSession, ErroLogin, parseNumeroMaximo } from '../src/podium/session.ts'
import type { Pessoa } from '../src/types.ts'

// Mock server que replica o comportamento do site (nenhum TLS).
let srv: Server
let base: string
let capturedRegistrar = ''

const TURMAS_OPTIONS = '<select><option value="">Selecione</option><option value="6474">Colégio Dom Jaime - Turma 303</option></select>'

beforeAll(async () => {
  srv = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://localhost')
    const body: Buffer[] = []
    req.on('data', c => body.push(c))
    req.on('end', () => {
      if (u.pathname === '/' && req.method === 'POST') {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ turmas: TURMAS_OPTIONS }))
        return
      }
      if (u.pathname === '/autenticacao.php') {
        if (body.join('').includes('errada')) {
          res.statusCode = 200
          res.end('login_falhou')
          return
        }
        res.setHeader('Set-Cookie', 'PHPSESSID=abc123; path=/')
        res.statusCode = 302
        res.setHeader('Location', '/main.php?conteudo=principal')
        res.end()
        return
      }
      if (u.pathname === '/main.php') {
        res.end(`
          <html><body>
            <a href="?conteudo=sair">Logout</a>
            <form id="rifa" action="/registrar_rifa.php"></form>
            <table><tr><th>Nº</th></tr><tr><td>0001104</td></tr></table>
          </body></html>
        `)
        return
      }
      if (u.pathname === '/registrar_rifa.php') {
        capturedRegistrar = body.join('')
        res.setHeader('Set-Cookie', 'PHPSESSID=abc123; path=/')
        res.statusCode = 302
        res.setHeader('Location', '/main.php?conteudo=form_rifa')
        res.end()
        return
      }
      res.statusCode = 404
      res.end('not found')
    })
  })
  await new Promise<void>(r => srv.listen(0, r))
  const addr = srv.address()
  base = `http://127.0.0.1:${(addr as { port: number }).port}`
})

afterAll(() => {
  srv.close()
})

describe('PodiumSession.login', () => {
  it('descoberta turma e obtém sessão', async () => {
    const s = await PodiumSession.login('86730169087', 'senha123', { baseUrl: base })
    expect(s.cookieHead).toContain('PHPSESSID=abc123')
  })

  it('lança ErroLogin quando credencial errada', async () => {
    await expect(PodiumSession.login('86730169087', 'errada', { baseUrl: base })).rejects.toBeInstanceOf(ErroLogin)
  })
})

describe('PodiumSession em sessão', () => {
  it('submete rifa com máscaras, campos e botão enviar, e lê maior Nº', async () => {
    const s = await PodiumSession.login('86730169087', 'senha123', { baseUrl: base })
    const p: Pessoa = { nome: 'Maria', cpf: '86730169087', telefone: '11987654321', email: 'm@x.com', qtd: 1 }
    await s.submeterRifa(p)
    expect(capturedRegistrar).toContain('enviar=Enviar')
    expect(capturedRegistrar).toContain('campos%5Bnome%5D=Maria')
    expect(capturedRegistrar).toContain('campos%5Bcpf%5D=867.301.690-87')
    expect(await s.lerMaiorNumero()).toBe(1104)
    expect(await s.checarSessao()).toBe(true)
  })
})

describe('parseNumeroMaximo', () => {
  const paginaOk =
    '<html><form action="/registrar_rifa.php"><table><tr><th>Nº</th><th>Nome</th></tr>' +
    '<tr><td>0001104</td><td>a</td></tr><tr><td>1234567</td><td>b</td></tr></table></form></html>'

  it('lê o maior número da coluna Nº', () => {
    expect(parseNumeroMaximo(paginaOk)).toBe(1234567)
  })

  it('ignora números de 7 dígitos fora da coluna Nº (telefone/id/data)', () => {
    const html =
      '<h1>celular 99988771</h1><form action="/registrar_rifa.php"><table>' +
      '<tr><th>Nº</th><th>Telefone</th><th>Id</th></tr>' +
      '<tr><td>0001104</td><td>11987654321</td><td>8888777</td></tr></table></form>'
    expect(parseNumeroMaximo(html)).toBe(1104)
  })

  it('retorna 0 para tabela vazia (conta nova)', () => {
    expect(parseNumeroMaximo('<form action="/registrar_rifa.php"><table><tr><th>Nº</th></tr></table></form>')).toBe(0)
  })

  it('lança erro quando a página não é o formulário autenticado', () => {
    expect(() => parseNumeroMaximo('<html>login page</html>')).toThrow(/formulário autenticado/)
  })

  it('aceita variações de cabeçalho (N°, Numero da rifa)', () => {
    const html =
      '<form action="/registrar_rifa.php"><table><tr><th>Numero da rifa</th></tr><tr><td>0000055</td></tr></table></form>'
    expect(parseNumeroMaximo(html)).toBe(55)
  })
})