// Réplica da página real /main.php?conteudo=form_rifa, dados fictícios, em bytes ISO-8859-1.
// layout 'lista' = site redesenhado (estrutura copiada em 2026-11-22, padrão);
// layout 'tabela' = site antigo (copiado em 2026-10-08).

export interface RifaFixture {
  numero: string
  nome: string
  cpf: string // com máscara, como o site mostra
}

const FORM = `<form method="post" action="/registrar_rifa.php" id="rifa" enctype="multipart/form-data">
  <input type="text" name="campos[nome]" required />
  <input type="text" name="campos[cpf]" required />
  <input type="text" name="campos[telefone]" required />
  <input type="email" name="campos[email]" required />
  <input type="submit" name="enviar" value="Enviar" />
</form>`

function listaVendas(rifas: RifaFixture[]): string {
  const cartoes = rifas
    .map(
      r => `<div class="row" style="grid-template-columns:minmax(0,1fr) auto;align-items:start">
<div><b>${r.nome} </b><div class="muted small" style="overflow-wrap:anywhere">${r.cpf} · (11) 98765-4321 · x@exemplo.com.br · Ensino Médio</div></div>
<div style="text-align:right"><b>Nº ${r.numero}</b><div class="muted small">20/09/2026 10:00</div></div>
</div>`
    )
    .join('\n')
  return `<section class="panel" aria-labelledby="h-vendas">
<h2 class="sec" id="h-vendas">Suas vendas</h2>
<div class="rows">
${cartoes}
</div>
</section>`
}

export function htmlFormRifa(
  rifas: RifaFixture[],
  opts: { semForm?: boolean; semTabela?: boolean; layout?: 'lista' | 'tabela' } = {}
): string {
  const linhas = rifas
    .map(
      r => `                    <tr align="center">
                <td data-title="Nº">${r.numero}</td>
                <td data-title="Nome">${r.nome}</td>
                <td data-title="CPF">${r.cpf}</td>
                <td data-title="E-mail">x@exemplo.com.br</td>
                <td data-title="Telefone">(11) 98765-4321</td>
                <td data-title="Ano">2026</td>
                <td data-title="Tipo">Rifa comum</td>
                <td data-title="Data"><span style="display: none;">2026-09-20 10:00:00</span>20/09/2026 10:00</td>
            </tr>`
    )
    .join('\n')
  const tabela = `<table border="0" cellpadding="0" cellspacing="0" id="imoveis" class="formandos rifa-tabela">
    <thead>
        <tr>
            <th>Nº</th>
            <th>Nome</th>
            <th>CPF</th>
            <th>E-mail</th>
            <th>Telefone</th>
            <th>Ano</th>
            <th>Tipo</th>
            <th>Data</th>
        </tr>
    </thead>
    <tbody>
${linhas}
            </tbody>
</table>`
  return `<html><head><meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1" /></head><body>
<a href="logoff.php">Sair</a>
${opts.semForm ? '' : FORM}
${opts.semTabela ? '' : opts.layout === 'tabela' ? tabela : listaVendas(rifas)}
</body></html>`
}

export const emLatin1 = (html: string): Buffer => Buffer.from(html, 'latin1')

export function rifa(numero: number, cpfMascarado: string, nome = 'Fulano de Tal'): RifaFixture {
  return { numero: String(numero).padStart(7, '0'), nome, cpf: cpfMascarado }
}
