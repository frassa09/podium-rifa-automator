import { describe, expect, it } from 'vitest'
import { parseLinhas } from '../src/utils/tableParser.ts'

describe('parseLinhas CSV (ponto e vírgula)', () => {
  it('parseia linhas válidas e aplica qtd padrão', async () => {
    const texto = [
      'Nome;CPF;Telefone;E-mail',
      'Maria Silva;86730169087;11987654321;maria@x.com',
    ].join('\n')
    const r = await parseLinhas({ texto })
    expect(r.total).toBe(1)
    expect(r.ok).toHaveLength(1)
    expect(r.ok[0]?.pessoa).toEqual({
      nome: 'Maria Silva',
      cpf: '86730169087',
      telefone: '11987654321',
      email: 'maria@x.com',
      qtd: 1,
    })
    expect(r.invalidas).toHaveLength(0)
  })

  it('aceita cabeçalhos variantes e qtd explícito', async () => {
    const texto = [
      'Nome Completo;CPF;Qtd de rifas;fone;Mail',
      'João;86730169087;2;1138765432;joao@x.com',
    ].join('\n')
    const r = await parseLinhas({ texto })
    expect(r.ok[0]?.pessoa.qtd).toBe(2)
    expect(r.ok[0]?.pessoa.telefone).toBe('1138765432')
  })

  it('separa linhas inválidas com motivos', async () => {
    const texto = [
      'Nome;CPF;Telefone;E-mail',
      'Bom;86730169087;11987654321;bom@x.com',
      'CPF ruim;12345678900;11987654321;bom@x.com',
      ';-;11987;ruim',
    ].join('\n')
    const r = await parseLinhas({ texto })
    expect(r.ok).toHaveLength(1)
    expect(r.invalidas).toHaveLength(2)
    expect(r.invalidas[1]?.erros.some(e => e.includes('inválido'))).toBe(true)
  })
})

describe('parseLinhas TSV (colado do Excel)', () => {
  it('parseia com tab como separador', async () => {
    const texto = 'Nome\tCPF\tTelefone\tEmail\nAna\t86730169087\t11987654321\ta@b.com'
    const r = await parseLinhas({ texto })
    expect(r.ok).toHaveLength(1)
    expect(r.ok[0]?.pessoa.nome).toBe('Ana')
  })
})

describe('parseLinhas XLSX', () => {
  it('parseia buffer de planilha xlsx', async () => {
    const XLSX = await import('xlsx')
    const ws = XLSX.utils.aoa_to_sheet([
      ['Nome', 'CPF', 'Telefone', 'E-mail', 'Qtd'],
      ['Carlos', '86730169087', '11987654321', 'carlos@x.com', 3],
    ])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Rifas')
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
    const r = await parseLinhas({ arquivo: buf as ArrayBuffer, nomeArquivo: 'rifas.xlsx' })
    expect(r.ok).toHaveLength(1)
    expect(r.ok[0]?.pessoa.qtd).toBe(3)
  })
})