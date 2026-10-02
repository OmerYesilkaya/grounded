# Grounded

A tutor that teaches any subject from first principles: unconditional truths first, every step
motivated, no word used before it has been taught. Invite-only; learners bring their own AI provider key.

- `method.md`: the teaching method, used as the system prompt (sections tagged by phase)
- `docs/design.md`: the design and every decision behind it

## Development

Requires Node 24 (`.nvmrc`), pnpm 9 and Docker.

```sh
pnpm install
cp .env.example .env
pnpm db:up          # local Postgres
pnpm lint && pnpm typecheck && pnpm test
```

To look at homework, arc exams and the final without working through sessions to reach them,
`pnpm stages` makes a database of its own (`grounded_stages`) with a track stopped at each stage, for
one learner (`--email`, `--password`; `--only exam-open,…` for some), and prints how to point
`pnpm dev:api` at it. Run it again to start over (`docs/design.md` §10).

## Deploy (Railway)

One Docker image runs the API (which also serves the web app) and the worker; see `docs/design.md`
§4.2. The Railway project (Postgres, `@grounded/api`, `@grounded/worker`) is described in
`.railway/railway.ts` and changed through it:

```sh
railway login && railway link -p grounded -e production   # once
railway config plan    # what would change; changes nothing
railway config apply   # apply after reviewing the plan
```

Pushes to `main` deploy both services once CI passes; each API deploy runs the migrations first.
`DATABASE_URL` is a reference to the database, set on each service in the file (Railway leaves a
reference to another service empty in a shared variable). Secrets live only on Railway (shared variables:
`KEY_VAULT_MASTER_KEYS`, `KEY_VAULT_ACTIVE_KID`, `AUTH_SECRET`; on the API: `APP_URL`) and appear in
the file as `preserve()`. The worker takes an optional
`YOUTUBE_API_KEY` (YouTube Data API v3), so lesson clips' times are checked against the video's
length (`docs/design.md` §6.4). Keep a copy of `KEY_VAULT_MASTER_KEYS` outside Railway: without it,
stored API keys can't be decrypted.

Invite people from a shell in the API service (`railway ssh -s @grounded/api`):
`pnpm cli invite someone@example.com` prints their one-time invite code once; give it to them and they
sign in with their email and the code as the password, then choose a password of their own, and stay
signed in. Only the code's hash is stored, so a lost code or a forgotten password is replaced by
running invite again (the old code and password stop working). `pnpm cli revoke someone@example.com`
shuts them out at once; `pnpm cli list` shows who is invited and where their sign-in stands.

Use a direct Postgres connection, never a transaction-mode pooler: jobs and streams rely on
`LISTEN/NOTIFY`. To try the image locally: `docker build -t grounded .`, then run it with the variables
above (`node --import tsx src/worker.ts` starts the worker).
