# podium-rifa-automator

Automação de cadastro de rifas (Ação entre Amigos) no site restrito da Podium Eventos e Formaturas.

## Dev Environment

- Install: `npm install`
- Dev: `npm run dev` (servidor + frontend web mobile)
- Build: `npm run build`
- Test: `npm run test`
- Lint: `npm run lint`

## Arquitetura

- `server/` — backend Node.js: API HTTP + motor de automação (cliente HTTP com cookie de sessão) contra `https://restrita.podiumeventosformaturas.com.br`
- `web/` — frontend web mobile (mobile-first, roda em qualquer celular)
- Credenciais de login do site ficam somente no servidor (arquivo local de configuração), nunca no frontend.

## Code Style

- TypeScript strict mode
- Single quotes, no semicolons
- Use functional patterns where possible
- Co-locate component-specific styles with the component

## PR Instructions

- Title format: `[podium-rifa-automator] Description`
- Run `npm run lint` and `npm run test` before committing
- Add or update tests for code you change

## Testing

- Run `npm test` for unit tests
- Run `npm run test:e2e` for end-to-end tests (if applicable)
- Fix any test or type errors until the suite is green

## File Structure

```
podium-rifa-automator/
├── server/
│   ├── src/
│   │   ├── api/
│   │   ├── engine/
│   │   └── data/
│   └── tests/
├── web/
│   ├── src/
│   │   ├── components/
│   │   ├── hooks/
│   │   └── utils/
│   └── tests/
├── docs/
│   └── superpowers/specs/
├── DESIGN.md
└── AGENTS.md
```

## Obsidian Integration

**Vault:** `C:\Users\renat\OneDrive\Documentos\Presença Digital - Negócio`
**Project folder:** `Projects/podium-rifa-automator/`

### Sync Rules
- Architecture decisions → `Decisions.md`
- Session notes → `Notes.md`
- Important links → `Links.md`

> Nota: o MCP do Obsidian estava com incompatibilidade de schema; usar o filesystem do vault como fallback.