# Design — Automação de Cadastro de Rifas (Podium Ação entre Amigos)

**Data:** 2026-09-12
**Status:** Aprovado para planejamento
**Projeto:** `podium-rifa-automator`

---

## 1. Objetivo

Automatizar o cadastro de rifas (bilhetes) da **"Ação entre Amigos"** no sistema restrito da Podium Eventos e Formaturas (`https://restrita.podiumeventosformaturas.com.br`), para um vendedor/formando.

O site cadastra **uma rifa por vez**. Hoje o usuário digita manualmente os dados do comprador (nome, CPF, telefone, e-mail) para cada rifa vendida. O objetivo é que o usuário carregue uma lista de compradores e o sistema faça **todas as rifas de forma automática, uma por uma**, monitorando progresso e erros pelo celular.

**Requisito de plataforma:** controle via dispositivo móvel (qualquer celular — Android, iPhone — via navegador web). O "motor" roda em um servidor (inicialmente o PC do usuário).

## 2. Contexto do site alvo (mapeado em 2026-09-12)

- **Domínio:** `restrita.podiumeventosformaturas.com.br` (subdomínio correto é `restrita`, não `restrito`). Certificado TLS self-signed — o cliente precisa ignorar erro de TLS.
- **Tecnologia:** PHP 5.6 (nginx), antibugado, formulários clássicos (sem renderização via JS). Não há SPA nem requisitos de navegador — **automação via HTTP direto com cookie de sessão** é viável e mais robusta que Playwright.
- **Login** (3 passos):
  1. `POST /` com corpo `usuario=<CPF>` → resposta JSON `{"turmas": "<option ...>…"}` (mesmo AJAX que o site faz quando o CPF é digitado).
  2. Extrair `value` da option da turma (ex: turma 303 = `6474`).
  3. `POST /autenticacao.php` com `usuario`, `turma`, `senha` → **302** para `main.php?conteudo=principal` + cookie `PHPSESSID`.
- **Tela da rifa:** `GET /main.php?conteudo=form_rifa`.
  - Formulário `<form method="post" action="/registrar_rifa.php" id="rifa">` — sem token CSRF, sem campos ocultos.
  - Campos: `campos[nome]`, `campos[cpf]`, `campos[telefone]`, `campos[email]`.
  - Máscaras client-side: CPF `999.999.999-99`; telefone `(99) 99999-9999` → o envio deve usar o mesmo formato mascarado.
  - Validação client-side `validarCPF` (dígito verificador padrão) → replicar no app para filtrar CPF inválido **antes** de submeter.
- **Envio:** `POST /registrar_rifa.php` com os 4 campos → **302** para `main.php?conteudo=form_rifa`.
- **Verificação:** a página `form_rifa` lista a tabela de rifas já cadastradas (colunas: `Nº`, `Nome`, `CPF`, `E-mail`, `Telefone`, `Ano`, `Tipo`, `Data`). Cada envio bem-sucedido adiciona **1 novo Nº** (sequência observada: 1003 → 1104, zero-padded a 7 dígitos). Após cada POST, confirmar sucesso lendo o maior Nº / a presença da nova linha.

## 3. Arquitetura

Duas partes conversando via HTTP:

- **Servidor (motor + API)** — roda no PC do usuário (inicial) ou VPS (futuro).
  - Motor de automação: cliente HTTP com **cookie jar** (mantém `PHPSESSID`). Implementa login e a sequência registrar+verificar.
  - API HTTP (localhost/LAN): configuração de login, criação de "jornada" (job), status/progresso, cancelamento, reprocessamento de erros, upload da tabela.
  - Persistência: SQLite (simples, sem serviço externo) — configuração, jobs, status por linha, logs.
- **Frontend web (mobile)** — PWA ou página responsiva servida pelo próprio servidor.
  - Tela de configuração (CPF/senha/turma + botão "testar login").
  - Importação da tabela (`xlsx`/`csv`/colar texto).
  - Botão **Iniciar cadastro**.
  - Painel de progresso em tempo real (por linha), resumo final, reprocessamento de erros.

### Motivo de não usar navegador automatizado (Playwright)
O site é PHP clássico: a automação real se resume a 2 requisições HTTP por rifa. Isento de instaladores de navegador, mais rápido (~1–2 s/rifa), mais estável (sem seletores frágeis) e funciona em VPS barato.

## 4. Fluxo do usuário

1. Usuário inicia o servidor no PC (`npm run dev`) e acessa o app pelo celular na mesma rede.
2. Configura login uma vez (CPF, senha; turma é descoberta automaticamente) e toca **"Testar login"**.
3. Prepara a tabela com os compradores (no computador ou colando no próprio app): colunas `Nome`, `CPF`, `Telefone`, `E-mail`, `Qtd` (opcional, padrão 1).
4. Importa a tabela no app → pré-validação (CPF com dígito verificador, campos obrigatórios) com lista de avisos.
5. Toca **Iniciar** → o motor cadastra rifa por rifa.
6. O painel mostra cada linha: `pendente → cadastrando → ok/erro`. Resumo `X cadastrados, Y com erro`.
7. Linhas com erro podem ser reprocessadas em lote com 1 toque.

## 5. Motor de automação (detalhe)

**Login** (reaproveitado a cada job, mantendo a sessão):
1. `POST /` com `usuario=<CPF>` → parse do JSON → extrair option da turma.
2. `POST /autenticacao.php` (`usuario`, `turma`, `senha`) seguindo o 302.
3. Guardar cookie `PHPSESSID` no cookie jar.

**Registrar 1 rifa:**
1. `GET /main.php?conteudo=form_rifa` → extrair **maior Nº** atual da tabela (caso já logado, para usar como baseline).
2. Formatar campos com as máscaras (CPF `999.999.999-99`, telefone `(99) 99999-9999`).
3. `POST /registrar_rifa.php` com `campos[nome]`, `campos[cpf]`, `campos[telefone]`, `campos[email]` (seguir 302).
4. `GET /main.php?conteudo=form_rifa` → **confirmar** que o maior Nº incrementou (ou que a combinação nome+data novo apareceu). Sucesso → `ok`; senão → tentativa novamente (máx. 2 retries).

**Multiplicidade (`Qtd`):** se `Qtd > 1`, submeter os mesmos dados `Qtd` vezes consecutivas (cada uma vira um novo Nº).

**Tolerância a falhas:**
- Timeouts por requisição (ex: 30 s) e retry exponencial breve.
- Sessão expirada → refazer login e retomar a mesma linha.
- Linha com CPF inválido → marcar `erro` na etapa de pré-validação (não chega a submeter).

## 6. Importação de dados

- Formatos aceitos: `.csv`, `.xlsx` e colagem de texto (parse simples TSV/CSV).
- Colunas aceitas: `nome`, `cpf`, `telefone`, `email`, `qtd` (aceitar variações de cabeçalho: "Nome Completo", "Qtd de rifas", etc.).
- Pré-validação por linha: CPF (11 dígitos + dígito verificador), e-mail (formato), telefone (mínimo de dígitos), nome não vazio, `qtd` inteiro ≥ 1.
- Normalização de dados: CPF sem pontos, telefone sem máscara na entrada; máscara aplicada **no envio**.

## 7. Tratamento de erros

| Cenário | Comportamento |
|---|---|
| Login inválido | Aviso na tela "Testar login" — não inicia job |
| Sessão expirada durante job | Refaz login transparentemente e retoma |
| Falha na submissão da linha | 2 tentativas; depois marca `erro` com motivo e segue |
| Serviço fora do ar / timeout | Job pausado com status legível; retomável |
| Tabela com linhas inválidas | Linhas válidas seguem; inválidas ficam `erro` com motivo claro |

Status por linha persistido; **nunca** re-submeter linha já confirmada `ok` (idempotência por Nº registrado no log).

## 8. Segurança

- Credenciais do site ficam **somente no servidor** (arquivo de configuração local com permissões restritas). O frontend nunca recebe/armazena a senha.
- A API é acessível apenas em `localhost`/rede local; sem autenticação exposta à internet (padrão).
- Sempre imitar o comportamento do navegador (headers `User-Agent`, `X-Requested-With`) para não degradar a experiência do site.
- Logs não exibem a senha; CPF pode aparecer em logs de execução (dados do próprio usuário).

## 9. Testes

- **Unidade:** parse da tabela, CPF validator (contra casos válidos/inválidos conhecidos), máscaras, parser da tabela de Nº.
- **Integração (modo "seco"):** login real + leitura da página `form_rifa` sem submeter nada.
- **E2E com 1 linha real:** botão "testar com 1 item" usando um comprador real indicado pelo usuário (sem dados falsos residuais).
- **Cancelamento:** parar job no meio e confirmar que linhas já `ok` não são reprocessadas.

## 10. Stack

- Servidor: Node.js (>=18) + TypeScript strict
  - HTTP client: `undici` ou `fetch` nativo + cookie jar (implementação própria leve)
  - API: `express` (ou http nativo)
  - Banco: `better-sqlite3`
  - Planilhas: `xlsx` (SheetJS) para `.xlsx`; parser próprio para `.csv`/texto
- Frontend: HTML/CSS/JS vanilla (mobile-first, sem framework) servido pelo Node — ou React + Vite conforme preferência de plano. **Referência visual: DESIGN.md** (paleta, tipografia, componentes).

## 11. Fora de escopo

- Não automatiza a venda/pagamento/emissão de bilhete visual.
- Não altera nada no site da Podium (somente automação de formulário existente).
- Não agenda execuções (não há cron/agendamento).

## 12. Critérios de aceite

1. Login automático funciona com a conta real (turma descoberta).
2. Importar tabela → pré-validação com avisos claros.
3. Cadastro de N rifas em sequência, uma por uma, confirmado pela tabela de Nº do site.
4. Progresso visível no celular em tempo real.
5. Reprocessamento de apenas as linhas com erro.
6. Sessão expirada no meio do lote é recuperada sem duplicar.

---

## Decisões registradas

| # | Decisão | Motivo |
|---|---|---|
| D1 | Subdomínio correto é `restrita.*`, não `restrito.*` | DNS público confirma (resposta NXDOMAIN para `restrito`, A record para `restrita`) |
| D2 | Motor via HTTP + cookie jar, não Playwright | Site PHP clássico; custo/estabilidade |
| D3 | Verificação por incremento do Nº na tabela | Confirmação objetiva de sucesso do POST |
| D4 | Senha só no servidor | Segurança |
| D5 | Job idempotente por linha confirmada | Evita duplicidade em reprocessamento |