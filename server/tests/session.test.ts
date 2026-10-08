import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { PodiumSession, ErroLogin, parseRifas, lerTexto, codificarFormLatin1 } from '../src/podium/session.ts'
import { criarSiteFalso, type SiteFalso } from './fixtures/siteFalso.ts'
import { emLatin1, htmlFormRifa, rifa } from './fixtures/formRifa.ts'
import type { Pessoa } from '../src/types.ts'

let site: SiteFalso

beforeAll(async () => {
  site = await criarSiteFalso([rifa(1003, '867.301.690-87'), rifa(1004, '111.444.777-35')])
})

afterAll(async () => {
  await site.fechar()
})

// Decodifica a página como o app faz (bytes ISO-8859-1 → texto).
const pagina = (html: string) => lerTexto(new Response(emLatin1(html)))

describe('PodiumSession.login', () => {
  it('descobre turma e obtém sessão', async () => {
    const s = await PodiumSession.login('86730169087', 'senha123', { baseUrl: site.base })
    expect(s.cookieHead).toContain('PHPSESSID=abc123')
    expect(s.turma).toBe('6474')
  })

  it('lança ErroLogin quando credencial errada', async () => {
    await expect(PodiumSession.login('86730169087', 'errada', { baseUrl: site.base })).rejects.toBeInstanceOf(ErroLogin)
  })
})

describe('PodiumSession em sessão', () => {
  it('lê as rifas da página real em ISO-8859-1 (regressão do bug "Nº 0→0")', async () => {
    const s = await PodiumSession.login('86730169087', 'senha123', { baseUrl: site.base })
    expect(await s.lerRifas()).toEqual([
      { numero: '0001003', cpf: '86730169087' },
      { numero: '0001004', cpf: '11144477735' },
    ])
    expect(await s.checarSessao()).toBe(true)
  })

  it('submete com máscaras, botão enviar e acentos em ISO-8859-1', async () => {
    const s = await PodiumSession.login('86730169087', 'senha123', { baseUrl: site.base })
    const p: Pessoa = { nome: 'José Conceição', cpf: '86730169087', telefone: '11987654321', email: 'jose@x.com', qtd: 1 }
    await s.submeterRifa(p)
    const corpo = site.posts.at(-1)!
    expect(corpo).toContain('enviar=Enviar')
    expect(corpo).toContain('campos%5Bnome%5D=Jos%E9+Concei%E7%E3o')
    expect(corpo).toContain('campos%5Bcpf%5D=867.301.690-87')
    expect(corpo).toContain('campos%5Btelefone%5D=%2811%29+98765-4321')
    expect(corpo).toContain('campos%5Bemail%5D=jose%40x.com')
    const rifas = await s.lerRifas()
    expect(rifas).toHaveLength(3)
    expect(site.rifas.at(-1)!.nome).toBe('José Conceição')
  })
})

describe('codificarFormLatin1', () => {
  it('codifica acentos como bytes únicos e espaço como +', () => {
    expect(codificarFormLatin1({ a: 'ã é', b: 'x&y=z' })).toBe('a=%E3+%E9&b=x%26y%3Dz')
  })

  it('normaliza NFD (acento separado, comum no iPhone) antes de codificar', () => {
    expect(codificarFormLatin1({ n: 'José' })).toBe('n=Jos%E9')
  })

  it('recusa caractere fora de ISO-8859-1 em vez de enviar errado', () => {
    expect(() => codificarFormLatin1({ n: 'Ana 😀' })).toThrow(/não é aceito/)
  })
})

describe('parseRifas', () => {
  it('lê Nº e CPF de cada linha, ignorando o span oculto da data', async () => {
    const html = await pagina(htmlFormRifa([rifa(1003, '867.301.690-87', 'Ana Lúcia'), rifa(1310, '111.444.777-35')]))
    expect(parseRifas(html)).toEqual([
      { numero: '0001003', cpf: '86730169087' },
      { numero: '0001310', cpf: '11144477735' },
    ])
  })

  it('tabela sem linhas (conta nova) devolve lista vazia', async () => {
    expect(parseRifas(await pagina(htmlFormRifa([])))).toEqual([])
  })

  it('decodificar como UTF-8 (o bug antigo) é detectado: cabeçalho não reconhecido lança', () => {
    const utf8Errado = new TextDecoder('utf-8').decode(emLatin1(htmlFormRifa([rifa(1003, '867.301.690-87')])))
    expect(() => parseRifas(utf8Errado)).toThrow(/Cabeçalho da tabela de rifas mudou/)
  })

  it('lança quando não é a página autenticada', () => {
    expect(() => parseRifas('<html>login</html>')).toThrow(/formulário autenticado/)
  })

  it('lança quando a tabela some (nunca devolve vazio por engano)', async () => {
    expect(() => parseRifas(htmlFormRifa([], { semTabela: true }))).toThrow(/não encontrada/)
  })

  it('lança quando uma linha tem formato inesperado', async () => {
    const html = (await pagina(htmlFormRifa([rifa(1003, '867.301.690-87')]))).replace('0001003', 'abc')
    expect(() => parseRifas(html)).toThrow(/Nº inesperado/)
  })

  it('lança quando a linha perde colunas', async () => {
    const html = (await pagina(htmlFormRifa([rifa(1003, '867.301.690-87')]))).replace(/<td data-title="Ano">2026<\/td>/, '')
    expect(() => parseRifas(html)).toThrow(/colunas/)
  })
})
