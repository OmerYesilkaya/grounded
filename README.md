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

## Deploy (Railway)

One Docker image runs the API (which also serves the web app) and the worker; see `docs/design.md`
§4.2. To set it up on Railway:

1. Create a project and add a **Postgres** database.
2. Add two services from this repo, `api` and `worker`. In each service's settings, set the config file
   path to `railway/api.json` or `railway/worker.json`.
3. Set these variables on both services (shared variables work well):
   - `DATABASE_URL=${{Postgres.DATABASE_URL}}`
   - `KEY_VAULT_MASTER_KEYS=k1:<openssl rand -base64 32>` and `KEY_VAULT_ACTIVE_KID=k1`
   - `BETTER_AUTH_SECRET=<openssl rand -base64 32>`
   - `APP_URL=https://<the api service's public domain>`
   - `RESEND_API_KEY` and `EMAIL_FROM` (only emails to your own address work until a domain is verified in Resend)
4. Give `api` a public domain. Each deploy of `api` runs the migrations first.
5. Invite people from a shell in the `api` service (`railway ssh`): `pnpm cli invite someone@example.com`.

Use a direct Postgres connection, never a transaction-mode pooler: jobs and streams rely on
`LISTEN/NOTIFY`. To try the image locally: `docker build -t grounded .`, then run it with the variables
above (`node --import tsx src/worker.ts` starts the worker).

## How to read the logs

The API (`pnpm dev:api`) and the worker (`pnpm dev:worker`) log to their terminals, one line per
entry with its fields as JSON; in production, JSON lines on stdout (the text in `message`, the
level in `level`). `LOG_LEVEL` sets how much: `info` by default, `debug` adds queued jobs, appended
events and SSE streams, `trace` everything.

- Every line carries its ids: `requestId`, `userId`, `sessionId`, `trackId`, and for a job `jobId`,
  `task`, `stepId` and the `requestId` of the request that queued it. To follow one session, filter
  by its id: `pnpm dev:worker | grep <sessionId>` locally; on Railway, search a service's logs for
  `@sessionId:<sessionId>`; for JSON lines saved elsewhere, `jq 'select(.sessionId == "<id>")'`.
  A request id leads from a click to the jobs it queued.
- Start from the failures: `request refused` / `request failed` (with the `reason`), `job failed`
  (with `err` and its `cause` chain; `handled: true` when the learner was shown the error),
  `model call failed` (the provider's `status` and error `body`), `session event rejected` (the
  state machine's `reason`), `... broke rules` (the validators' issue codes), `track edits rejected`,
  `recovered a session ...`.
- Each `model call` line has the purpose, model, tokens and `durationMs`; `session state changed`
  lines trace a session's phases.
- Keys, magic-link tokens (outside development) and anything a learner or the tutor wrote are never
  logged (design §4.2): for content, look in the database.
