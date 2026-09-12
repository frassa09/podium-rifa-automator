import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { PodiumSession, ErroLogin } from '../src/podium/session.ts'
import type { Pessoa } from '../src/types.ts'

// Mock server que replica o comportamento do site (nenhum TLS).
let srv: Server
let base: string

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
  it('submete rifa com máscaras e lê maior Nº', async () => {
    const s = await PodiumSession.login('86730169087', 'senha123', { baseUrl: base })
    const p: Pessoa = { nome: 'Maria', cpf: '86730169087', telefone: '11987654321', email: 'm@x.com', qtd: 1 }
    await s.submeterRifa(p)
    expect(await s.lerMaiorNumero()).toBe(1104)
    expect(await s.checarSessao()).toBe(true)
  })
})