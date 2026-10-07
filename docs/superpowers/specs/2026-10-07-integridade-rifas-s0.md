# §0 — Respostas da investigação somente-leitura de `form_rifa`

**Data:** 2026-10-07 · **Spec:** `2026-10-07-integridade-rifas.md`
**Captura:** `server/scripts/capturarFormRifa.ts` (só login + `GET main.php?conteudo=form_rifa`; nenhum POST em `/registrar_rifa.php`).
**Fixture:** `server/tests/fixtures/form_rifa.real.html`, gerada por `server/scripts/anonimizarFormRifa.ts` (estrutura, Nº, datas e distribuição de rifas por comprador preservadas; nomes, CPFs, e-mails, telefones, vendedor e nº do orçamento fictícios).

## Respostas

1. **Lista completa? Sim.** O servidor manda todas as linhas no HTML (168 linhas, Nº 1003…1285, datas de 11/09 a 07/10). A paginação é só no navegador: DataTables com `sPaginationType: 'full_numbers'` e `iDisplayLength: 10`, sem `bServerSide`/`sAjaxSource`, sem `LIMIT` visível e sem links de página. Quem lê o HTML direto (sem JS) enxerga a tabela inteira. Ressalva: não há como provar que não existe um limite no servidor acima de 168. Recomenda-se conferir isso de novo quando a conta tiver centenas de rifas.
2. **Ordem: crescente** por Nº (e por data). A primeira linha é a mais antiga.
3. **Só as rifas desta conta (deste vendedor).** Entre 1003 e 1285 existem 283 Nº, mas só 168 aparecem, com saltos de 5, 5, 11, 23 e 76. As rifas que faltam no intervalo são de outros vendedores e não aparecem na tabela. O cabeçalho e o fieldset "Dados do Vendedor" mostram o usuário logado.
4. **Sim, o Nº é uma sequência global** (no mínimo entre vendedores). Os saltos acima confirmam isso, igual ao 1003 → 1104 do spec original. Uma rifa nova pode fazer o maior Nº subir mais de 1, e o maior Nº também sobe com rifas de outras pessoas.
5. **Não dá para responder por completo sem POST.** O que o HTML mostra:
   - o formulário é `method="post" action="/registrar_rifa.php" enctype="multipart/form-data"`, com os campos `campos[nome|cpf|telefone|email]` e `enviar=Enviar`. O motor envia `application/x-www-form-urlencoded`, o que o PHP aceita igual, mas é uma diferença;
   - a página `form_rifa` **não tem área de mensagem** de sucesso ou erro: nenhum `?msg=`, nenhum "CPF já cadastrado", nenhum "Rifa registrada". Os únicos avisos são estáticos, e a validação de CPF existe só no JS, com `alert`;
   - o JS bloqueia o duplo envio do formulário (`$("form").submit` → `return false` na segunda vez). Isso indica que o site **não** evita duplicata no servidor;
   - pelo login, o site usa o padrão `302 → página?msg=...`. Senha errada responde `302 → index.php?msg=invalido`, e login certo responde `302 → main.php?conteudo=principal`. É provável que `registrar_rifa.php` siga o mesmo padrão, mas isso **não foi verificado**. Para verificar: DevTools → Network com "Preserve log" ligado num cadastro manual legítimo, ou no teste controlado do §4.6.

## Achados extras (afetam o spec)

- **O parser atual nunca lê o Nº na página real.** O site responde `Content-Type: text/html; charset=ISO-8859-1`, mas `Response.text()` decodifica como UTF-8. O `º` vira `U+FFFD`, o rótulo fica `N�` e não bate com `ROTULOS_NUMERO`. Por isso `parseNumeroMaximo` devolve **0** tanto na captura real quanto na fixture. No `Automator`, isso significa `base = 0` e `n0 = nDepois = 0` sempre, ou seja, `criadas = 0` depois de cada POST e o loop reenvia. Essa é a causa mais provável do sintoma "dá erro, mas cria e duplica", mais até do que P1. O spec deve incluir: decodificar como ISO-8859-1 e localizar colunas por `data-title`/posição, não por texto acentuado.
- **P7/§2.6 corrigido pela observação real:** senha errada **não** devolve `200 login_falhou`, e sim `302 → index.php?msg=invalido`. O código atual aceita qualquer 302 (e o `PHPSESSID` já existe), então trata senha errada como login OK. O critério certo é `302` com `Location` contendo `main.php`.
- **Contar por CPF (§2.1) é viável:** a tabela é completa, desta conta, e o CPF vem sempre formatado como `999.999.999-99`. O nome **não** é chave confiável: o mesmo CPF aparece com e sem espaço no final do nome.

## Decisão para o §2.1

A chave de verificação por **contagem de linhas com o CPF do comprador** está validada para seguir, com duas condições: (a) decodificar a página como ISO-8859-1; (b) falhar se a tabela `#imoveis` ou o formulário autenticado não forem encontrados, sem nunca devolver 0.
