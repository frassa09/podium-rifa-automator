# Deploy no Render (grátis) + Neon

Passo a passo para colocar o Rifa Automator na internet e usar pelo celular com segurança.

## 1. Banco (Neon)

1. Crie conta em <https://neon.tech> → **New Project**.
2. Região: **AWS US East 1 (N. Virginia)** — a mesma do Render (`region: virginia` no `render.yaml`).
3. Em **Connection Details**, marque **Pooled connection** e copie a URL
   (`postgresql://...-pooler...neon.tech/neondb?sslmode=require`). Ela é o `DATABASE_URL`.

As tabelas são criadas sozinhas no primeiro boot.

## 2. Serviço (Render)

1. Suba o repositório para o GitHub (privado).
2. No Render: **New → Blueprint** → escolha o repositório. Ele lê o `render.yaml`.
3. Preencha as variáveis pedidas:

| Variável | Valor |
|---|---|
| `DATABASE_URL` | URL pooled do Neon |
| `RIFA_PIN` | PIN de **8+ dígitos**, aleatório (não use data de nascimento/sequência) |
| `RIFA_CPF` / `RIFA_SENHA` | Conta da Podium (recomendado: assim a senha nunca vai para o banco) |
| `RIFA_TURMA` | Opcional |
| `MAX_QUANTIDADE` | Já vem `100` |

4. **Apply**. O primeiro build leva alguns minutos. Abra a URL `https://<nome>.onrender.com`.

Se o log mostrar `Boot recusado`, falta `RIFA_PIN` (ou é curto) ou `DATABASE_URL` — é proposital:
o servidor não sobe exposto sem PIN nem sem banco persistente.

## 3. Uso no celular

- Abra a URL, digite o PIN. Ele fica só na aba (some ao fechar).
- **Adicionar à tela inicial** no navegador para virar "app".
- 5 PINs errados seguidos bloqueiam aquele IP por 15 min.

## 4. O que saber do plano grátis

- **O Render dorme após ~15 min sem acesso.** O primeiro acesso depois disso demora ~30–60 s.
- **Deixe a aba de Progresso aberta enquanto um job roda.** Ela mantém o serviço acordado.
  Se ele dormir/reiniciar no meio, nada duplica: no boot o job volta para `pendente`; na aba
  **Histórico** reabra e inicie de novo — o motor re-mede o Nº no site e cria só o que falta.
- Neon free pausa o banco ocioso; a reconexão é automática.

## 5. Como o app evita criar rifas a mais

- Cada rifa é confirmada **contando as rifas do CPF na tabela do site** (o Nº não serve: é uma
  sequência compartilhada com outras contas).
- **No máximo `qtd` envios por linha, para sempre.** O envio é registrado antes de acontecer.
- **Nada é reenviado automaticamente.** Se um envio não aparecer na tabela, o job para e a linha
  mostra *"Confira no site antes de reprocessar"*. Então:
  1. Abra o site da Podium e veja quantas rifas aquela pessoa tem.
  2. Se estiver tudo lá: **Reprocessar erros** → **Iniciar**. O app reconta e só marca ok, sem enviar.
  3. Se faltar: o mesmo. O app reconta e envia só o que falta.
- Criar outro job para alguém que tem linha em aberto pede confirmação explícita.
- Linhas criadas pela versão anterior (antes de 2026-10-08) ficam bloqueadas: confira no site e,
  se faltar algo, crie um job novo só com o que falta.

## 6. Segurança — resumo

- HTTPS do Render + PIN em toda rota de API (exceto `/api/health`), com trava anti força-bruta.
- Credenciais da Podium só em variáveis de ambiente; a API nunca devolve a senha.
- Cabeçalhos: CSP estrita, `X-Frame-Options: DENY`, HSTS, `no-store` na API.
- Para trocar o PIN: altere `RIFA_PIN` no painel do Render (o serviço reinicia sozinho).
- Nunca commite `.env` (já está no `.gitignore`).

## Risco conhecido

`xlsx` (SheetJS) do npm tem vulnerabilidades sem correção no npm (prototype pollution / ReDoS ao
abrir planilha maliciosa). Só quem tem o PIN envia planilhas, então o risco é baixo. A correção
oficial é instalar a versão do CDN do SheetJS
(`npm i https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz -w server`).
