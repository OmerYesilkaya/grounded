# Grounded

A tutor that teaches any subject from first principles: unconditional truths first, every step
motivated, no word used before it has been taught. Invite-only; learners bring their own AI provider key.

- `method.md`: the teaching method, used as the system prompt (sections tagged by phase)
- `docs/design.md`: the design and every decision behind it
- `prototypes/`: throwaway UI prototypes
- `test/`: the chat-app version of the method used for manual testing

## Development

Requires Node 24 (`.nvmrc`), pnpm 9 and Docker.

```sh
pnpm install
cp .env.example .env
pnpm db:up          # local Postgres
pnpm lint && pnpm typecheck && pnpm test
```
