# Design — Hospedagem gratuita (Render + Neon), endurecimento anti-duplicação e acesso por PIN

**Data:** 2026-09-14
**Status:** Aprovado para planejamento
**Projeto:** `podium-rifa-automator`

---

## 1. Objetivo

Hospedar o `podium-rifa-automator` **sem custo** (Render free + Neon free como Postgres externo) e **endurecer o sistema contra qualquer erro de criação de rifas** no site da Podium — duplicação ou criação extra são inaceitáveis, pois não existe opção de apagar rifa no site. O fluxo de login/config local (PC/LAN) continua suportado.

Precedências (ordem de relevância):
1. **Nunca duplicar / nunca criar além do pedido.**
2. Manter o app utilizável no PC/LAN como hoje.
3. Hospedar de graça, com dados persistentes entre restarts/deploys.

## 2. Decisões registradas

| # | Decisão | Motivo |
|---|---|---|
| D1 | Render (web service free) como hospedagem + Neon (Postgres free) como banco | Disco do Render free é efêmero; banco externo garante persistência sem custo |
| D2 | Camada de banco com interface única e 2 implementações: `SqliteBanco` (local/testes) e `PostgresBanco` (`pg` + Neon, produção) | Preserva os 51 testes atuais; risco baixo ao trocar armazenamento sem tocar no motor |
| D3 | Teste de paridade SQLite×Postgres via PGlite | Garante que as duas implementações se comportam igual, offline e determinístico |
| D4 | Execução de **job único por vez**, com claim atômico no banco | Elimina duplicação por cliques múltiplos, abas, restarts ou múltiplas instâncias |
| D5 | Reconciliação de estado no boot (`rodando`→`pendente`, `cadastrando`→`pendente`) | Retomada segura após crash/restart sem re-submeter |
| D6 | Correção do falso-`ok` (nunca assumir `base=0`; falha de medição aborta a linha) | Falha silenciosa poderia marcar `ok` sem criar rifa |
| D7 | `lerMaiorNumero` lê apenas a **coluna Nº** e valida que a página é o formulário autenticado | Números de 7 dígitos espúrios (telefone/id/data) não podem contaminar medição |
| D8 | Teto servidor `MAX_QUANTIDADE` (padrão 100) + confirmação explícita do total antes de criar e iniciar | Erro de digitação (ex.: 100000) não pode criar rifas em massa |
| D9 | Acesso por PIN (`RIFA_PIN`, header `X-PIN`), exceto `/api/health` | API pública no Render com poder de criar rifas reais precisa de proteção simples |
| D10 | Credenciais da Podium via env (`RIFA_CPF`/`RIFA_SENHA`/`RIFA_TURMA`) quando presentes; senão tela de Login grava no banco | Senha nunca vai para banco na nuvem; modo LAN preservado |

## 3. Arquitetura de deploy

```
[ Celular / navegador ]
        │ HTTPS + PIN (X-PIN)
        ▼
[ Render Web Service (free) — Node 20, processo contínuo ]
   • express API + estático do frontend
   • motor de automação (Automator) roda na memória
        │ postgres (TLS)
        ▼
[ Neon Postgres (free) — 0,5 GB, 190 h/mês ]
   • config, jobs, linhas, logs (persistem entre restart/sleep/deploy)
```

- **Render free**: dorme após ~15 min sem tráfego e acorda no próximo acesso. Tab aberta (polling 1,5 s) mantém acordado. Cold start Render+Neon de alguns segundos ao acordar — não afeta a criação de rifas (o motor espera normal).
- **Neon free**: compute é pausado quando ocioso; `DATABASE_URL` aponta para a conexão *pooled*.
- **`render.yaml`** (blueprint): web service free, build `npm ci && npm run build`, start `npm run start`, variáveis `DATABASE_URL`, `RIFA_PIN`, `RIFA_CPF`, `RIFA_SENHA`, `RIFA_TURMA`, `MAX_QUANTIDADE` (opcional).
- Frontend continua sem credenciais (a API nunca devolve a senha).

### Variáveis de ambiente

| Variável | Obrigatória (deploy) | Padrão | Efeito |
|---|---|---|---|
| `PORT` | Render injeta | `3000` | Porta HTTP |
| `DATABASE_URL` | sim (nuvem) | ausente | Presente → `PostgresBanco`; ausente → SQLite |
| `RIFA_PIN` | sim (nuvem) | vazio | Vazio → autenticação desligada (modo LAN) |
| `RIFA_CPF` | não | — | Presente → sobrepõe config do banco |
| `RIFA_SENHA` | não | — | idem |
| `RIFA_TURMA` | não | — | idem |
| `MAX_QUANTIDADE` | não | `100` | Teto de rifas por pessoa |

Sem `DATABASE_URL` **e** sem `RIFA_PIN` o app funciona como hoje, 100% local.

## 4. Camada de dados dupla

- `Banco` vira **interface assíncrona**: a API e os callbacks falam com a interface, nunca com o banco concreto.
- `SqliteBanco` (better-sqlite3): comportamento atual; abre conexão por operação (WAL).
- `PostgresBanco` (`pg`): mesmo schema em dialeto PostgreSQL (`BIGSERIAL`, `RETURNING` etc.); usa `pool`/`client` via adaptador de `query(text, params)`.
- **Seleção**: `await Banco.abrir()` decide por `DATABASE_URL`. Local/testes ficam 100% offline.
- **Transações**: cada implementação faz transação do seu jeito. `criarJob` (job + linhas) é transacional nas duas.
- **Claim de job único** (Seção 5) é uma única instrução atômica idêntica nos dois bancos.
- Tabelas: `config`, `jobs`, `job_linhas`, `logs` (mesmo schema lógico atual).
- **Paridade via PGlite**: a mesma suíte de asserções do SQLite roda contra PGlite (Postgres WASM), usando o mesmo adaptador de `query`. Se o teste de paridade encontrar divergência, o menos confiável é re-avaliado antes do merge.
- Ajustes decorrentes: chamadas de banco viram `await` na API; callback `log`/`atualizarLinha`/`atualizarStatusJob` do motor continuam síncronos para o Automator (internamente o servidor faz fire-and-forget com `.catch()`).

## 5. Proteções contra duplicação / criação extra

Invariantes centrais (já válidos e preservados):
- O **Nº do site é a única verdade**: nada é submetido sem medir quanto falta; nada vira `ok` sem o site provar o incremento.
- Submissão sempre de `qtd=1` por vez, seguida de re-medição; aborta quando `faltando <= 0`.

Endurecimentos novos:

1. **Single-flight (job único por vez).** Instrução atômica no banco:
   `UPDATE jobs SET status='rodando' WHERE id=? AND status!='rodando' AND NOT EXISTS (SELECT 1 FROM jobs WHERE status='rodando' AND id!=? )`
   `changes>0` → posse; senão `409`. Independe de memória/processo: sobrevive a restart, redeploy e instâncias múltiplas. Não há caminho para 2 runners no mesmo espaço de Nº.
2. **Reconciliação no boot.** `rodando`→`pendente`, `cadastrando`→`pendente`. `base`/`enviadas` persistem → retomada re-mede o site e cria só o que falta.
3. **Falso-`ok` corrigido.** Falha na medição inicial do `base` **aborta** a linha com erro claro (nunca `base=0`, nunca `ok` sem medição real).
4. **Leitura confiável do Nº.** Parse da **coluna `Nº`** (cabeçalho `Nº`, primeira célula de cada linha) + validação de que a página é o formulário autenticado. Página errada/sessão caída → erro (aborta a linha, sem `0` silencioso). Tabela vazia legítima (conta nova) retorna `0`.
5. **Teto e confirmação.** `MAX_QUANTIDADE` (padrão 100) validado no servidor na criação do job (linha acima → rejeitada). Frontend mostra o total de rifas do job e exige confirmação explícita **antes de criar** e **antes de iniciar**.
6. **Nunca submeter além do alvo.** O loop só submete com `faltando > 0` e confirma após cada envio; com single-flight, a criação máxima é exatamente o que falta.

## 6. Acesso por PIN e credenciais

- `RIFA_PIN` definido → middleware exige header `X-PIN` em todas as rotas exceto `/api/health`. Comparação à prova de timing (`crypto.timingSafeEqual` sobre digest).
- Frontend: 401 → tela de PIN; PIN fica em `sessionStorage`; estáticos continuam públicos (inofensivos sem API).
- Sem `RIFA_PIN` → proteção desligada (modo LAN) com log de aviso.
- Credenciais: env (`RIFA_CPF`/`RIFA_SENHA`/`RIFA_TURMA`) tem **prioridade sobre** a config do banco. Com env presente: aba de Login vira aviso "configurado via ambiente"; API recusa escrita de config (`409`). `/api/config` nunca devolve a senha.
- `.env.example` documenta as variáveis (sem segredos commitados).

## 7. Frontend

1. **Tela de PIN** (401 → prompt; `X-PIN` em toda chamada).
2. **Confirmação do total** antes de criar o job e antes de iniciar: *"Serão criadas N rifas para M pessoas. Confirmar?"*.
3. **Tela "Histórico" (nova)**: lista jobs (`id`, status, ok/erro) para reabrir → retomar/reprocessar sem re-submeter (pós-crash no Render).
4. **Modo env**: aba Login substituída por aviso; exibe limite `MAX_QUANTIDADE`.
5. Manter telas/política visual atuais (DESIGN.md) — sem framework novo.

## 8. Testes

- Ajustar suíte existente (`await` na camada de banco) e manter **lint/typecheck/test verdes**.
- Novos:
  - Medição inicial falha → linha `erro`, com aborto (nunca falso-`ok`).
  - `lerMaiorNumero` com HTMLs diversos: coluna `Nº`, 7-dígitos espúrios ignorados, tabela vazia → `0`, página errada → erro.
  - Teto `MAX_QUANTIDADE` (job rejeita qtd acima).
  - PIN: `401` sem/errado/`X-PIN`; `/api/health` liberado; comparação à prova de timing.
  - Single-flight: 2º job → `409`; claim atômico sobrevive a "restart" (novo processo sem memória compartilhada).
  - Reconciliação no boot.
  - Paridade SQLite×Postgres (PGlite).
- E2E seco (`RIFA_CPF`/`RIFA_SENHA`) continua: login + leitura apenas, sem submeter.
- Dependências novas: `pg`, `@types/pg` (prod); `@electric-sql/pglite` (teste).

## 9. Estrutura de arquivos prevista

```
server/src/data/
  banco.ts            # interface Banco + factory (escolhe impl por DATABASE_URL)
  sqliteBanco.ts      # better-sqlite3
  postgresBanco.ts    # pg (Neon) — usa adaptador query(text, params)
server/src/api/server.ts  # PIN middleware, single-flight, recon de boot, config env
server/src/podium/session.ts  # lerMaiorNumero por coluna Nº + validação de página
server/src/engine/automator.ts # falso-ok corrigido
web/src/  # tela PIN, confirmações, tela Histórico, modo env
render.yaml            # blueprint Render free + variáveis
.env.example
```

## 10. Fora de escopo

- Autenticação multi-usuário (email/senha real).
- Cron/agendamento de execução.
- UI além do necessário ao endurecimento (sem redesenho).
- Qualquer plano pago de hospedagem.

## 11. Critérios de aceite

1. Deploy no Render free funciona com `DATABASE_URL` Neon; dados persistem após restart/deploy.
2. Com `RIFA_PIN`, toda ação exige o PIN; health responde.
3. Com env de credenciais, aba de Login some e escrita de config é recusada.
4. Dois "iniciar" simultâneos do mesmo job → apenas um roda; segundo recebe `409`.
5. Crash/restart no meio de um job → boot reconcilia, retomada não duplica nem cria além do alvo.
6. Falha inicial de medição do Nº → linha `erro`, com aborto (nunca falso-`ok`).
7. Linha com `qtd > MAX` é rejeitada na criação; confirmação de total antes de criar/iniciar.
8. Suíte `npm run typecheck` + `npm test` + `npm run lint` verde; paridade SQLite×Postgres passa.