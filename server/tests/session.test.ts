import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { PodiumSession, ErroLogin, parseRifasDaTabela, contarRifasDoCpf } from '../src/podium/session.ts'
import type { Pessoa } from '../src/types.ts'

// Tabela no formato real de form_rifa (§0), só com as colunas que o parser usa e mais uma.
function tabela(linhas: [string, string][]): string {
  const corpo = linhas.map(([n, cpf]) => `<tr align="center"><td data-title="Nº">${n}</td><td data-title="Nome">X</td><td data-title="CPF">${cpf}</td></tr>`).join('')
  return `<table id="imoveis" class="formandos rifa-tabela"><thead><tr><th>Nº</th><th>Nome</th><th>CPF</th></tr></thead><tbody>${corpo}</tbody></table>`
}

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
        // Igual ao site real: ISO-8859-1 (o "º" é o byte 0xBA).
        res.setHeader('Content-Type', 'text/html; charset=ISO-8859-1')
        res.end(Buffer.from(`
          <html><body>
            <a href="?conteudo=sair">Logout</a>
            <form id="rifa" action="/registrar_rifa.php"></form>
            ${tabela([['0001104', '867.301.690-87'], ['0001105', '111.444.777-35'], ['0001109', '867.301.690-87']])}
          </body></html>
        `, 'latin1'))
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
  it('submete rifa com máscaras, campos e botão enviar, sem seguir redirect, e conta por CPF', async () => {
    const s = await PodiumSession.login('86730169087', 'senha123', { baseUrl: base })
    const p: Pessoa = { nome: 'Maria', cpf: '86730169087', telefone: '11987654321', email: 'm@x.com', qtd: 1 }
    expect(await s.submeterRifa(p)).toEqual({ status: 302, location: '/main.php?conteudo=form_rifa' })
    expect(capturedRegistrar).toContain('enviar=Enviar')
    expect(capturedRegistrar).toContain('campos%5Bnome%5D=Maria')
    expect(capturedRegistrar).toContain('campos%5Bcpf%5D=867.301.690-87')
    expect(await s.contarRifasDoCpf('86730169087')).toBe(2)
    expect((await s.lerRifas()).map(r => r.numero)).toEqual([1104, 1105, 1109])
    expect(await s.checarSessao()).toBe(true)
  })
})

describe('parseRifasDaTabela', () => {
  const form = '<form action="/registrar_rifa.php"></form>'

  it('lê a fixture real inteira (168 linhas, 31 CPFs) com o rótulo "N�" de Latin-1 lido como UTF-8', () => {
    const html = readFileSync(new URL('./fixtures/form_rifa.real.html', import.meta.url), 'utf8')
    const rifas = parseRifasDaTabela(html)
    expect(rifas).toHaveLength(168)
    expect(new Set(rifas.map(r => r.cpf)).size).toBe(31)
    expect([rifas[0]?.numero, rifas.at(-1)?.numero]).toEqual([1003, 1285])
  })

  it('conta só as linhas do CPF, aceitando CPF com ou sem máscara', () => {
    const rifas = parseRifasDaTabela(form + tabela([['1', '867.301.690-87'], ['2', '111.444.777-35'], ['3', '867.301.690-87']]))
    expect(contarRifasDoCpf(rifas, '867.301.690-87')).toBe(2)
    expect(contarRifasDoCpf(rifas, '11144477735')).toBe(1)
    expect(contarRifasDoCpf(rifas, '00000000000')).toBe(0)
  })

  it('tabela vazia (conta nova) devolve lista vazia', () => {
    expect(parseRifasDaTabela(form + tabela([]))).toEqual([])
  })

  it('lança erro quando a página não é o formulário autenticado', () => {
    expect(() => parseRifasDaTabela('<html>login page</html>')).toThrow(/formulário autenticado/)
  })

  it('lança erro (nunca 0) quando a tabela #imoveis não existe', () => {
    expect(() => parseRifasDaTabela(form + '<table><tr><th>Nº</th></tr></table>')).toThrow(/imoveis/)
  })

  it('lança erro quando falta a coluna CPF', () => {
    const html = form + '<table id="imoveis"><thead><tr><th>Nº</th><th>Nome</th></tr></thead><tbody></tbody></table>'
    expect(() => parseRifasDaTabela(html)).toThrow(/Colunas/)
  })

  it('lança erro quando uma linha está fora do formato (CPF inválido ou células faltando)', () => {
    expect(() => parseRifasDaTabela(form + tabela([['1', '867.301.690-87'], ['2', '---']]))).toThrow(/Linha 2/)
    const curta = form + '<table id="imoveis"><thead><tr><th>Nº</th><th>CPF</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>'
    expect(() => parseRifasDaTabela(curta)).toThrow(/Linha 1/)
  })
})
