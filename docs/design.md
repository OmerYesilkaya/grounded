# Grounded — design

A web app that teaches any subject with Omer's method: from unconditional truths upward, every
step motivated, no word used before it has been taught. Friends and family sign in, bring their own
AI provider key, and learn in tracks.

This document is the source of truth for the build. It records every decision from the two grilling
sessions (2026-09-25 → 27) and the lesson-page prototype, with the reason where the reason matters.

Product name: **Grounded** (repo `grounded`, packages `@grounded/*`). The display name lives in one
config value.

---

## 1. Scope

**v1**

- Sign-in (allowlist + magic link), key entry, provider/model choice.
- Tracks; the full session loop (probe → plan → lesson → inline checks → homework → close).
- Lessons rendered by our own block renderer (no HTML), with asides as margin cards.
- Homework (typed kinds, image upload, review on submit), arc exams, the final.
- Learner profile (teaching notes, used in every call; visible and editable) and simple per-track stats.
- Usage logging on every model call, with a simple display.
- Responsive web: on a phone, reading, checks and asides work well.

**v2**

- Daily quiz and email (and email reminders for snoozed homework).
- Homework "rework for my situation".
- Full profile page (teaching notes and history across tracks).
- Export and delete-everything.
- Runnable code (JS and Python, in the browser), generated sound, interactive blocks, function plots.

**Not planned**: onboarding flow for API keys (Omer helps people get keys in person); an admin UI;
a "quick question" chat outside sessions (people use their everyday chatbot for that).

## 2. Principles and constraints

- **The app is a home for the method, not a new method.** `method.md` is the single copy; the app
  enforces it with phases, validators and renderer rules instead of trusting the prompt alone.
- **Bring your own key.** Every model call is paid by the learner's key. The data model also allows a
  _sponsored_ key (Omer pays for a specific person) without touching the core.
- **Nothing runs behind the learner's back.** No background model calls; everything is triggered by the
  learner being present (the v2 quiz generates its question when the link is opened).
- **Invite-only now, ready to scale later. No irreversible decisions.** Stateless API servers, a durable
  job queue, portable containers, an auth library that grows into open sign-up, envelope encryption
  behind an interface (details in §4).
- **Privacy is a policy we keep and state honestly.** No admin page, no UI for reading anyone's content,
  learner text and keys never in logs or error reports. The operator can technically read the
  database (the server must read content to build prompts) and does not.
- **Development cost carries little weight;** quality, simplicity, robustness and maintainability do.

## 3. The method in the app

### 3.1 `method.md`

- Lives at the repo root; extracted from Omer's Claude Code `teach` skill with his name, quotes and
  Claude Code specifics generalized. A chat-app version at `test/method.md` passed Omer's manual
  ChatGPT test; its transcripts seed the eval personas.
- Sections are **tagged by phase**; the server assembles each phase's prompt from the sections it
  needs (plus the learner profile and track state). One document to read and maintain; shorter,
  focused prompts per call — cheaper and much better for weaker models.
- Teach in the learner's language; terms are gated in the language taught.
- Omer migrates his existing tracks with an import script (`pnpm import-track`, §10) and becomes
  user #1.

### 3.2 Changes the app makes to the method (approved 2026-09-27)

| Today                                              | In the app                                                                                                                                                                     | Why                                                                                                                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The page is read in full, then checks in chat      | **Each step ends with an inline check; the next step unlocks when it lands**                                                                                                   | Restores the safety net the method lost when the terminal couldn't host both ("a bad step was caught by its check before anything was built on top of it") |
| A lesson opens with a "what rests on what" picture | **No opener.** A "what you just built" picture after the last check; the same picture in the plan and on track stats; all drawn from the term dependencies, never by the model | The opener spoils the discovery path and duplicates the approved plan; at the end it _is_ the click                                                        |
| Homework is never skipped                          | **Homework can be postponed ("Later", with snooze), never skipped silently;** the next homework subsumes an open one                                                           | Building homework teaches most; sometimes there is only room to read and think                                                                             |
| Hand-drawn SVG                                     | Mermaid (and other typed blocks)                                                                                                                                               | Auto-layout removes label overflow; validation is mechanical                                                                                               |
| Asides answered by a fresh `claude -p`             | Asides answered in the margin by a cheaper model; a question about later material gets a small taste and a promise                                                             | Curiosity served in the moment without spoiling the path                                                                                                   |

### 3.3 Enforcement

- **Validators with retry** run on everything learner-facing: banned scaffolding words, domain terms
  not yet confirmed (exact match against the track's term list and a per-track glossary; a cheap model
  reviews only what is left), structural rules (every step has a heading and a check), per-surface
  block allowlists (§6.3). A failure regenerates only the offending unit, with the error fed back.
- **Two severities.** Most of the banned words are also everyday English ("I assumed…", "a map").
  Unambiguous machinery ("ledger", "hangs off", "forced by", "Phase 2", "node 3") is an **error** and
  regenerates; the ambiguous words are sent to **review**, where the cheap model judges them in context.
  A word that is a usable domain term of the track (a graph-theory track's "graph") is never flagged.
  Code, inline code and maths are not checked; diagram captions and labels are.
- **The same validators are the eval harness's scorers** (§11), so "which models are allowed" is
  measured by the checks that protect learners every day.

## 4. Architecture

### 4.1 Monorepo

pnpm workspaces, TypeScript end to end.

```
apps/
  web/          Vite + React SPA, shadcn/ui (Tailwind + Radix), Tiptap, TanStack Router/Query
  api/          Hono on Node: HTTP + SSE, auth, job enqueueing
  worker/       job runners (lesson generation, grading, reviews, profile refresh) — same code base as api, separate process
packages/
  core/         method phases and the session state machine, prompt assembly, validators, domain types
  content/      block-tree types, markdown→tree parser, per-surface allowlists, validation (shared by web, api, worker, eval)
  providers/    Vercel AI SDK adapters (Anthropic, OpenAI, Gemini), model list config, usage accounting
  db/           Drizzle schema and migrations
  crypto/       envelope encryption behind a KeyVault interface
tools/
  eval/         eval harness (personas, runner, reports)
  cli/          `pnpm invite`, `pnpm revoke`, `pnpm import-tracks` (Omer's existing tracks)
method.md
```

Why not Next.js: everything is behind a login, search engines never see it, and the screens are
interactive tools. Server rendering buys nothing; a plain SPA plus plain HTTP/SSE is easier to reason
about, test and debug.

### 4.2 Runtime

- **Generations are jobs, not requests.** **graphile-worker** runs model calls in the worker process
  (`pnpm dev:worker`). It was chosen over pg-boss because it wakes workers through `LISTEN/NOTIFY`, so a
  chat reply starts at once instead of waiting for a poll. Jobs are attempted once: the SDK already
  retries provider calls, and a blind job retry could spend the learner's credit twice.
- **Every session has an ordered event log** (`session_events`). Jobs append to it as they stream and
  send a Postgres notification; one listener per API process wakes that session's SSE streams. The
  browser replays from its last event id after a reconnect or a closed tab. A session's events become
  visible in id order: appending one takes the session's event lock (a transaction-scoped advisory
  lock) before its id, so a later event can't commit before an earlier one and be skipped by a stream
  or a snapshot cursor that is already past it. Sessions don't wait for each other. The lock order is
  the event lock, then the session row; a state transition appends its state event in its own
  transaction, so states arrive in the order they were applied. API servers hold no state
  in memory, so API and workers scale independently; Redis replaces `NOTIFY` only if Postgres becomes
  the bottleneck.
- **Jobs say what they are doing.** Alongside their output, jobs publish `activity` events
  (`{ id, label, detail, state: "running" | "done" }`, the latest per id wins: "Thinking…", "Searching
  the web for …", "Writing step 3 of 12") and, where the provider streams one, the model's reasoning
  summary as `activity-reasoning`. The web shows them as a compact live status line, so a long job
  never looks stuck; the session snapshot lists the ones still running. The contract is documented
  in `apps/api/src/engine/events.ts`.
- **A worker that dies mid-job is cleaned up after.** A graceful failure cleans up itself (a message
  that fails is retracted, an activity always ends, a check answer that can't be graded is told so);
  a killed or crashed worker leaves its work half-done. graphile-worker can't tell a dead worker's
  job from a running one (it stays locked until a four-hour timeout), so each job holds its session's
  **work lock** while it runs: a shared Postgres advisory lock on a connection its process keeps for
  life, released by Postgres the moment the process is gone. When a worker starts, before taking
  jobs, it recovers every open session whose work lock it can take (exclusively, so no job can start
  there meanwhile): a tutor message still being written is retracted, running activities are ended,
  a check answer still waiting for a verdict gets the tutor's "That didn't go through… Answer again"
  (unless its check job is still queued), and a lesson that stopped being written, outlined or not,
  is marked failed (unless its job is still queued); each such session gets an `error` event.
  A lesson job that fails for any reason (the provider included) marks its lesson failed itself
  before telling the learner why, so an unfinished lesson is always one whose job died, and a failed
  one is never reported twice.
  Nothing is re-run: jobs are attempted once. A check job grades only an answer still waiting, so
  one that starts late never contradicts recovery. Running recovery again changes nothing. Open
  gaps: there is no "write the lesson again" path yet, so a failed lesson stays failed; a worker
  that dies while others keep running is recovered at the next worker start, not sooner.
- **Structured logs, through one logger** (pino, `apps/api/src/log.ts`): JSON lines on stdout in
  production (the message in `message` and the level's name in `level`, the fields Railway reads),
  one readable line per entry otherwise, at `LOG_LEVEL` (`trace`, `debug`, `info` (the default),
  `warn`, `error`, `silent`; tests are silent). Every line carries the ids of the context it was
  written in, kept in an `AsyncLocalStorage` rather than passed around: a request's `requestId` (a
  proxy's `x-request-id` is kept, and the response answers with it) and the `userId`, `sessionId`
  and `trackId` it touches. A job's lines carry its `jobId`, `task`, `sessionId` (and `stepId`), its
  session's `userId` and `trackId`, and the `requestId` of the request that queued it, so a job
  traces back to the click that started it. The API writes one line per request (method, route, path
  without its query, status, duration), with the reason for a 4xx or 5xx; an error no handler caught
  is logged with its cause chain and answered with a plain 500. Each job logs its start (and how
  long it waited) and its end: finished, or failed with the error's cause chain and its duration
  (`handled: true` when the learner was told and the job counts as done). graphile-worker's warnings
  and errors go through the same logger, its chatter at `debug`; recovery logs one line per session
  it cleaned up. The engine logs state transitions (the event, from → to), rejected events with the
  state machine's reason, validation failures and rewrites by issue code (chat messages, check
  replies, lesson outlines and steps), lesson steps that failed or were kept without their broken
  parts, rejected track edits (how many and which kinds: the reasons quote term names), plan
  retractions and retries, term-sweep retries, and every model call attempt: purpose, role,
  provider, model, tokens and `durationMs` (the timing `usage_events` records), and for a failure
  its kind and cause (status and the provider's error body). Appended events are logged at `debug`
  by type and id, streamed pieces at `trace`.
  **Never logged:** keys (plain or sealed), magic-link tokens outside development, or anything a
  learner or the tutor wrote, the track's title included: lines hold ids, counts, issue codes and
  the app's own messages. Errors are serialized field by field (type, message, stack frames, a
  provider's status and error body, the cause chain), never whole: an SDK error carries the request,
  and so the prompt. A message that quotes content (a failed JSON parse of the model's output) is
  withheld. A test runs a session through the real model caller, with a failing call and an
  unparseable reply, and asserts that its key, sealed key, magic-link token, title and answers never
  appear in the log.
- **Docker images, no host-specific services.** Start on Railway or Fly with managed Postgres; moving
  to AWS or elsewhere needs no rewrite. One image (`Dockerfile`) runs both processes: the API by
  default, the worker with `node --import tsx src/worker.ts`. The API runs its TypeScript through tsx
  (no build step: the packages export their sources), and serves the built web app itself
  (`WEB_DIST_DIR`), so the app and `/api` share one origin as they do behind Vite in development.
  Migrations run before each API deploy; `/healthz` answers once the database is reachable. Both
  processes stop gently on `SIGTERM`: the API ends its streams (browsers reconnect and replay), the
  worker finishes its jobs. Postgres needs a direct connection, not a transaction-mode pooler: jobs
  and streams rely on `LISTEN/NOTIFY`.
- **Railway now**, described in `.railway/railway.ts` (Railway's infrastructure as code; its older
  per-service config files are closed to new services) and applied with `railway config apply`: a
  Postgres database and two services built from the image, `@grounded/api` and `@grounded/worker`, all
  in one region so queries don't cross an ocean. A push to `main` deploys both once CI passes; no watch
  patterns, since any change can affect either. Secrets stay on Railway (`preserve()` in the file).
- **Every row is owned by a user; ids are UUIDv7.**

### 4.3 Auth and keys

- **Better Auth** (or equivalent that grows): email magic link, gated by an allowlist Omer manages with
  the CLI. Google sign-in and open sign-up later, behind configuration.
- **Email: Resend**, called through its REST API. With `RESEND_API_KEY` unset (development, tests), the
  link is printed to the API console. Until a domain is verified in Resend, only
  `onboarding@resend.dev` can send, and only to the Resend account's own address (`EMAIL_FROM`).
- **Keys:** envelope encryption — a per-row data key encrypts the API key; a master key (host secret
  now, a KMS later) encrypts the data keys. Decrypted only in the worker at call time; never sent to
  the browser after entry, never logged. Learners can replace or delete their key.
- **Credential source** is its own concept (`own_key` | `sponsored`), so sponsorship or paid plans
  later don't touch the core.

### 4.4 Providers and models

- **Vercel AI SDK** (the library only) hides provider differences for streaming, structured output,
  token usage and each provider's own web search tool. v1: Anthropic, OpenAI, Gemini.
- **Model list in code** (`packages/providers/models.config.ts`), each entry next to its eval results.
  Adding a model is a reviewed change. Learners pick from the list for their provider; no free-form
  model ids.
- Roles per provider: a **strong** model for planning, lessons, check grading and homework review
  (a wrong verdict costs more than a few cents); a **cheaper** model for asides and small jobs.
- **Research** replaces the `researcher` subagent: during planning (scoping the field, seeding planned
  terms) and whenever a fact is uncertain, the model runs with the provider's search tool on and
  returns notes with sources, stored on the track.
- Errors surface plainly: invalid key, out of credit, rate limited, refusal — each with what to do.
- **Time limits** on every model call, per purpose (`CALL_LIMITS` in `apps/api/src/engine/call-limits.ts`),
  applied in the middleware every model is wrapped in: a total for non-streamed calls; for streams a
  total, a limit on silence before the first part and between outputs (the model may be reasoning or
  searching unseen), and a shorter one mid-output. A call that runs out fails as "taking too long"
  and is logged and recorded. Retries of retryable failures happen in the middleware too, only
  within the time the call has left, so a learner never waits past the limit.
- **Usage** (input/output/cached tokens, model, purpose) is recorded for every call from day one and
  shown simply per session and per month. Each attempt also records its duration (`duration_ms`,
  from the request to a stream's finish or the failure), so the effect of caching and reasoning
  effort shows per purpose.
- **Prompts are ordered stable-first** (`assembleSystemPrompt` in `packages/core/src/prompt.ts`), so
  a provider can reuse the cached start of the previous call: the phase's method sections, then the
  track's slowly changing state (subject and language, plan, term list, borrowed terms, fix-list,
  teaching notes, in that order), then what only this call carries (the step being checked, research
  notes, the probe's conclusion), then the conversation. The track's state renders the same way on
  every load (terms and fix-list in creation order, what a term rests on in the term list's order),
  so two calls of a track and phase are byte-identical up to their own parts.
- **The track's part holds the track as the session began** (`loadTrackContext` with the session):
  the term list with each term's status as of the session's start (its last `term_events` change
  before then) and the fix-list as it stood then. What changed since (a term's new status, a term
  or fix-list item added, an item closed) comes first in the call's own part, under "Changed since
  this session began", which says it holds over the lists above. So the probe's records, a check's
  verdict or the plan's new terms don't change the track's part: it stays cached all session. The
  subject, language and plan are shown as they are now (they change about once a session). What the
  tutor writes is still validated against the track as it is now.
- **A session's prompts carry what matters of the track, not all of it** (`selectTrackView` in
  `packages/core/src/track-view.ts`; decided 2026-09-28, #13), computed from the track as the
  session began, so it holds all session:
  - The **current arc** is the first arc in plan order with a `planned` term: the ground the next
    lesson covers. Arcs are the plan's order, so a recorded reorder moves it too.
  - A term was **touched recently** when a `term_events` change was recorded for it in the three
    sessions of the track before this one (`RECENT_SESSIONS`), from the first of them to this one's
    start. An import's changes come before the track's first session, so they are never recent;
    in a track's second session, everything its first session planned is.
  - The **term list** holds the current arc's terms and the recently touched ones, plus everything
    those rest on, transitively (real maps are shallow: on the imported track a term and all it
    rests on are 3 terms on average, 12 at most). The rest is one line: how many more terms the
    track has, by status, and that they are not to be used as known terms. The server still
    validates every action and message against the whole list, so an omitted term can't be added
    twice or used before it is taught.
  - The **plan** lists the current arc's terms; every other arc is its title and a tally ("17
    terms (15 confirmed, 2 taught)"). The phases that record the plan (plan, close, final:
    `WHOLE_PLAN_PHASES`) see every arc's terms, since a `set-plan` replaces the whole plan. The
    other calls saw part of it, so a `set-plan` from them (the probe's decision, a check's verdict)
    is left out and the rest of the batch applies.
- **"Where you left off" stands in for the plan's notes** (`tracks.left_off`, decided 2026-09-28,
  #13; `apps/api/src/engine/left-off.ts`). The plan's notes as written (34 KB on the imported
  track) stay in the database and go only to the close: the recap and the term sweep read them,
  and a `set-plan` in the sweep replaces them in full (its request says to carry forward what still
  holds). After the sweep, one more call (`left-off`, little reasoning) writes the summary from the
  notes as the sweep left them and the whole session: open threads, owed work, what to re-check,
  where the next session picks up, in about 300 words. Every other call carries it, under the
  plan's arcs. The plan's record saw only the summary, so its `set-plan` replaces the arcs and its
  notes are added after the notes under "Noted while planning", for the next close to fold in.
  - If the close's summary fails, the track is left with none (not one from before the session),
    and prompts carry the notes as written until one is written.
  - Notes with no summary yet (the imported track, or any track before its first close): up to
    4,000 characters (`LEFT_OFF_CATCH_UP`) they are carried as written; longer ones get a summary
    written from the notes alone, once, before the session's opening question ("Reading where you
    left off"). If that fails, the session carries the notes as written.
- **A long session's older turns are carried as a summary** (`apps/api/src/engine/conversation.ts`;
  decided 2026-09-28, #13). While the session's messages after the summary total at most 40,000
  characters (`CONVERSATION_LIMIT`, about 10,000 tokens: several times a normal session's whole
  chat), they are carried in full. Past it, a call (`conversation-summary`, little reasoning) folds
  all but the last 10 messages (`KEEP_RECENT`) into the running summary, quoting the learner's own
  words where they are evidence; it is stored on the session (`earlier_summary`, up to the message
  `summarized_through`). Prompts then carry the summary as the conversation's first message and
  the messages after it in full. The summary changes only when it rolls forward again, so between
  rolls the conversation's start stays the same from call to call. If the call fails, the
  conversation is carried in full and the next call tries again. Check threads and asides are not
  part of it: each is short and carried whole where it belongs.
- **A budget per phase** (`PROMPT_BUDGETS` in `apps/api/src/engine/prompt-budget.ts`): the most
  one call may send, system prompt and conversation, in estimated tokens (characters / 4), on a
  track built like the imported one (204 terms with names as long as the real ones, 12 arcs, 14
  fix-list items, 34 KB of notes, three earlier sessions) with a normal session's chat.
  `prompt-budget.test.ts` runs every phase's job on it with scripted models and fails when a call
  goes over. Measured when set (#13), per call, before → after: probe and its decision ~30,000 →
  ~10,000; plan ~30,000 → ~14,000 (every arc's terms); lesson and homework ~30,500 → ~10,500;
  check ~28,300 → ~8,300; close (recap, sweep, where you left off) ~29,000 → ~21,000 (the whole plan and
  the notes as written). Budgets sit about a fifth above: probe 12,000, plan 17,000, lesson and
  homework 12,500, check 10,000, close 25,000. The method's sections are now the largest part
  (18–24 KB per phase), and they are the part every call reuses from the cache.
- **Cache hints** are added in the model middleware (`shapeCall` in
  `apps/api/src/engine/call-options.ts`), from the request's `trackId`. OpenAI: `promptCacheKey` is
  the track id, so a track's calls reach the same cache. Anthropic: the system prompt is sent as one
  block per part, with a cache breakpoint (`cacheControl: { type: "ephemeral" }`, 5 minutes) after the
  method and after the track's state, and the top-level `cacheControl` caches the whole prompt for the
  conversation's next call. Google caches implicitly. For OpenAI and Google the parts are joined back
  into one system message, so every provider reads exactly the assembled prompt.
- **Reasoning effort per purpose** (`REASONING` in `apps/api/src/engine/call-options.ts`), set in
  the same middleware through the AI SDK's provider-neutral `reasoning` option (OpenAI's reasoning
  effort, Anthropic's thinking effort or budget, Gemini's thinking level). The small structured
  records of what the conversation already showed think little (`low`): the probe's decision
  (`probe-decision`, its own purpose, apart from the probe's question) and the close's term sweep
  (`term-sweep`, apart from the recap), and so do the summaries of what is already written ("where
  you left off", `left-off`; a long session's older turns, `conversation-summary`). Everything else
  keeps the provider's default, above all plans, lessons and check grading.

## 5. Data model (sketch)

| Table                      | Holds                                                                                                 |
| -------------------------- | ----------------------------------------------------------------------------------------------------- |
| `users`, `allowlist`       | account; who may sign in                                                                              |
| `credentials`              | provider, encrypted key, credential source                                                            |
| `learner_profile_notes`    | teaching notes: text, evidence refs, created/revised at; editable by the learner                      |
| `tracks`                   | subject, teaching language, status, research notes, plan and its notes, "where you left off"          |
| `terms`                    | per track: term, status (`planned`/`taught`/`confirmed`/`assumed`), topic                             |
| `term_events`              | evidence history: status change, quoted learner words, source (check, homework, aside, exam)          |
| `term_dependencies`        | "rests on" edges — the map; source of every structure picture                                         |
| `borrowed_terms`           | term used in this track, confirmed in another                                                         |
| `arcs`, `fix_list_items`   | the plan's arcs and which session closes each; the audit's misconceptions and their status            |
| `sessions`                 | track, kind (normal / final), phase, open/closed, paused-at, a long chat's older turns summarized     |
| `messages`                 | chat messages of a session (probe, plan, recap) as block trees                                        |
| `lessons`, `lesson_steps`  | the lesson's block tree per step, outline, validation results                                         |
| `check_attempts`           | per step: answers, verdicts, repair threads, fresh questions, flags                                   |
| `asides`, `aside_messages` | anchor (block id + quote selector), thread, saved-for-later flag                                      |
| `assignments`              | homework or arc exam: kind, prompt blocks, "what a good answer shows" checklist, status, snooze-until |
| `submissions`              | typed fields (prediction with lock timestamp, reconciliation, steps, text), images                    |
| `reviews`                  | margin comments on a submission, checklist outcome (held / leaked / missing)                          |
| `usage_events`             | per model call                                                                                        |
| `imported_lessons`         | per imported track: the last lesson of the earlier setup, original HTML, shown read-only (§10)        |

The model never rewrites state. It returns small structured edits (promote term X with this evidence,
add planned term Y resting on Z, close fix-list item N) that the server validates and applies.

## 6. Content: format and renderer

### 6.1 Format

The model writes **markdown with typed fenced blocks** (` ```diagram `, ` ```stepper `, ` ```chart `,
`:::check`, `:::media`, …). The server parses each block as it completes into a **block tree with
stable ids**, validates it, and stores the tree. The renderer only ever sees validated trees; raw model
output is never rendered. Models write markdown far more reliably than large JSON, markdown streams
naturally, and ids are what asides, repair notes and validation hang off. No model-written code
(HTML/MDX/JS) runs anywhere.

### 6.2 Block types

| v1                                            | Notes                                                                                                                                                                                                                                                                             |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| paragraph, heading, list, quote, callout/note | "After the check-back" repair notes are marked notes under a step                                                                                                                                                                                                                 |
| code                                          | **Shiki** highlighting; a reserved `runnable` flag for v2                                                                                                                                                                                                                         |
| math                                          | **KaTeX**, inline and display                                                                                                                                                                                                                                                     |
| diagram                                       | `{ syntax: "mermaid", source, caption, highlight }` behind a `DiagramEngine` interface; theme in one file. Swapping to D2 or another engine later adds a `syntax` value; old lessons keep rendering. Mermaid's `classDef` needs hex colours (8-digit hex for alpha), not `rgba()` |
| stepper                                       | frames of diagram + caption with prev/next and a scrubber — for mechanisms that unfold over time (races, protocols); supported when needed, never the default                                                                                                                     |
| chart                                         | **Vega-Lite** spec; charts on real data carry their source                                                                                                                                                                                                                        |
| image                                         | **Wikimedia Commons** via a server-side `find_image` tool; licence and credit shown                                                                                                                                                                                               |
| video                                         | **YouTube** with start/end time, verified to exist                                                                                                                                                                                                                                |
| audio                                         | Commons audio (music samples, instruments, pronunciation) — "audio when needed"                                                                                                                                                                                                   |
| link card                                     | anything else from sources: title, site, one-line reason                                                                                                                                                                                                                          |
| check                                         | the step's question; answered and graded inline                                                                                                                                                                                                                                   |

v2: runnable code (JS in a Web Worker, Python via Pyodide — browser only, never on our servers),
generated sound (the model writes notes, the browser plays them), function plots, other interactives.

### 6.3 Per-surface allowlists

| Surface                                | Allowed                                                                                               |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Probe and plan chat                    | text-like only: paragraphs, lists, quotes, code, maths, tables (the plan picture is drawn by the app) |
| Lesson                                 | everything, and the only surface with checks                                                          |
| Repair thread, aside card, review card | text-like blocks plus diagram and stepper                                                             |
| Homework prompt                        | text-like blocks plus headings, diagram and media                                                     |

Code stays allowed in the chat because a probe question may need to show code in full ("what does
this print?"). The allowlists live in `@grounded/content` (`ALLOWED_BLOCKS`).

"The probe teaches nothing" is then enforced by the renderer and validator, not just requested.

### 6.4 Validation and failure

- A block is shown only once complete and validated; a quiet placeholder holds its place meanwhile.
- Invalid content regenerates **only that step**, with the exact error fed back; after two failed
  retries it degrades (diagram → caption + "diagram unavailable"; media → link card). A structural
  failure (missing check) cannot degrade: the step fails visibly with "regenerate".
- Every URL is resolved server-side before display; unverifiable media is dropped.
- Failures are logged per model and feed the eval (parse-failure rate is a gate metric).
- **Prefer top-to-bottom diagrams:** left-to-right Mermaid flowcharts shrink badly in a 68ch column
  (prototype finding). The prompt says so; wide figures may later break out of the text column.

## 7. The session

### 7.1 Phases

Server-owned state machine: **review → probe → plan → lesson (steps with inline checks) → homework →
close.** The model _proposes_ transitions through structured actions ("probing done; here is the
plan"); the server checks preconditions (a plan before a lesson; every check resolved before homework);
the learner approves at the gates (the plan). The learner can nudge at any time ("skip ahead to the
plan"). Sessions stay open indefinitely and resume where they stopped; **one open session per track**.

**Prose first, then structure.** A tutor message is streamed from a call with no tools, so a tool call
can never take the message's place; its actions and decisions (the plan's terms and arcs) come from a
separate structured call on the finished message. A reply without text is asked for again and never
stored. Before the first plan, research runs as its own call with the provider's search tool, and its
notes go into the plan's prompt.

**The probe decides first, then writes.** The session opens with the first probe question, written
from what the learner said they want to learn (the track's title, given in the opening turn). Every
later probe turn starts with the structured call: what the answers showed (term evidence, fix-list
items, the teaching language) and whether probing is finished. If not, the next question is written
with those records in its prompt. If it is, no probe message is written: the session moves to planning,
and the plan job is the only place a plan can appear (a model that felt done used to present the plan
in its last probe message, leaving the plan message with nothing to say). The decision's summary —
where the learner's knowledge ends, and their goal — is stored on the session (`probe_summary`) and
given to the plan's calls, research included; when the learner skips ahead to the plan there is none.

### 7.2 Lesson generation pipeline

1. **Research + outline** (search on): steps, the motivation for each, the terms each introduces, the
   drawings needed, the checks. Validated against the term list before any writing.
2. **Write** in one streamed call, rendered block by block — the learner reads step 1 while later
   steps are still being written (only unlocked steps are visible anyway).
3. **Validate per step**; regenerate only a failing step.

Lessons are expected at roughly 15–25 KB of markdown (the 50–90 KB of today's lessons was mostly
HTML/SVG). To be measured, then adjusted.

### 7.3 Inline checks and the gate

- Each step ends with its check (one or two lines). The strong model grades it inline.
- **Landed** → the next step unlocks, and the page scrolls to it once the verdict has been read.
- **Miss or "I don't know"** → a repair thread opens under the check (the one place explanation
  happens outside the lesson), then a **fresh** question on the same idea — never the same one again.
  A marked "After the check-back" note is added under the step; later steps are not rewritten.
- **Still shaky after a repair:** if the next step **rests on** this one (term dependencies), offer
  **Pause here** (next time opens with a fresh question on this idea — the incubation option) or
  **Continue anyway** (step flagged "settling", its terms stay `taught`, homework and the next session
  re-test it). If the next step doesn't rest on it, continue freely with the step flagged.
- Why a soft gate: building on a missing piece hurts when the next step uses it (mastery learning,
  cognitive load), but a later idea can make an earlier one click, a break helps (incubation), and
  repeated failure breeds helplessness. Later layers (homework, next-session review, the v2 quiz) catch
  what was continued past.

### 7.4 Homework, arc exams, the final

- **Typed homework kinds** with their own fields:
  - _Predict → verify_: prediction (locks with a timestamp on submit) → what actually happened →
    reconcile.
  - _Derivation_: a list of steps, each with a "because…".
  - _Build_: brief → what you submit (text, code, photos) → "what surprised you".
  - _Explain it to a friend_: one text box.
- Answers use a **Tiptap** editor with markdown shortcuts, code blocks, pasted images (the photo of a
  notebook), and `$…$` math; checks and asides use a one-line version.
- **Review starts on submit**, as margin comments anchored to parts of the answer (the same card
  component as asides), Socratic: point at the leak, ask the learner to find the flaw. A **checklist
  instead of a score**: each "what a good answer demonstrates" item is marked held / leaked / missing.
  Unresolved leaks carry into the next session's review.
- **Later** with snooze (tonight / tomorrow): in-app only in v1 (sidebar "tonight" badge, reminder on
  the next visit); email in v2. "Rework" is hidden until v2.
- **Arc exams** follow the method (transfer problems, cross-session questions, one build, re-tested
  misconceptions — never recall). Never taken halfway; "Later" allowed. Starting the next arc with an
  exam open gives one warning, and its re-tests fold into the next session's probe.
- **The final** is a session kind with no homework: a fresh audit (new fix-list compared with the
  original) and a teach-back where the model plays a skeptical friend asking only "why?" and "what if?".

### 7.5 Asides

- Select any passage in a lesson → ask. The card appears in the margin beside it, streamed at once.
- Context: the passage and its step, the whole lesson, the track's term list, earlier asides on the
  lesson. Model: the cheaper one. Obeys the term list; may use text, math, code, diagram, stepper.
- A few sentences by default, with follow-ups in the card. A question about something the lesson
  teaches later gets **a small taste plus the promise that it comes later**, never a spoiler.
  A tangent can be **saved for a future session** (added to the plan as a candidate).
- Anchoring: block id + the quoted passage with a little text before and after it, so a card survives
  a repair note being added nearby. Cards feed the check-back and the next session.

## 8. Learner profile and stats

- **Teaching notes** about how this person learns ("abstract ideas land after a concrete example
  first"; "prefers predict-then-verify"). Every note is phrased as teaching guidance, never a judgment
  of ability; cites its evidence (sessions, checks, asides); is revised or removed at each refresh, not
  appended. Built on evidence: the first after ~6 sessions (across tracks), a note needs a pattern in
  ≥3 sessions, refreshed ~every 5 sessions, at a session close (the learner is present). Always in
  context, kept to about a dozen notes. Visible and editable by the learner. No vocabulary in it.
- **Stats per track (v1):** ideas you own, ideas still settling (each clickable, in plain words),
  sessions done, open homework and exams, and the track's map. Learner-facing text never uses the
  method's scaffolding words — "ideas you own / still settling / to revisit", not
  "confirmed / taught / assumed".

## 9. UI

Visual direction: thin, minimal, modern — the look of today's AI tools, not their chat-only UX.
Built with **shadcn/ui** (Tailwind + Radix), themed with our own tokens.

### 9.1 Lesson page — prototype verdict

Prototype: `prototypes/lesson-page-prototype/index.html` (throwaway; run
`python3 -m http.server 4817` in that folder). Three structurally different variants were explored
(docs margin, focus reader, paged steps) and combined into:

- **Left: the track list**, collapsible (☰) for distraction-free reading.
- **Top: a Chat / Lesson switch.** Chat holds the session's conversation (probe, plan with its picture
  and approval). Lesson is the reading view.
- **Lesson view:** one continuous scroll; steps stack as they unlock (no pages, no prev/next).
  A **step timeline in the empty left gutter** of the reading column — only in Lesson view — follows
  the scroll; clicking an unlocked step scrolls to it; locked steps show as `·····` (upcoming headings
  would give away the discovery); it shrinks to dots when the gutter is narrow.
- **Reading column ~68ch, truly centred** when there is room; on tighter screens it slides left only as
  far as the margin cards need (Google Docs behaviour).
- **Margin cards** (Google Docs-style, a thin accent strip, a dashed connector to the highlighted
  passage when active, a slight lift on hover, follow-ups inside).
- **Discoverability of asking:** until the first question, the empty margin shows a faint hint card
  ("Stuck on a word or a step? Select any passage and ask about it…") with a tiny animated selection;
  it disappears after the first aside. A paragraph hover button was tried and dropped as not useful.
- Rejected along the way: a progress rail in the header (confusing while scrolling), page-per-step.

### 9.2 Track list

A refined "typographic index":

- A clearly visible **+ New track** button at the top (accent, dashed border), then search (`/`).
- **The current track** expanded as a ruled list (serif name; items with small-caps kind: session,
  homework, arc exam); the current session marked by an accent bar; due items tagged ("tonight").
- **Other tracks** as single serif lines with what is waiting ("1 due", "1 open"); click to expand;
  finished items fold ("3 done ▸").
- **At scale (15+):** ordered by recent activity, six shown, the rest under "N more tracks"; search
  filters tracks and lessons live.
- Account at the bottom.

### 9.3 Look

- Dark by default, light mode, "follow system".
- Serif for lesson text (Source Serif 4 in the prototype), clean sans for the app (Inter).
- One accent colour, shared by diagram highlights, checks, cards and due tags.
- Colour tokens defined once; Mermaid's theme generated from them.
- Streamed text appears as if written: the page reveals it at a reading pace (~90 characters a
  second, faster when far behind, always caught up within 1.5 s), fading in the newest words; a
  message turns into its rendered blocks once all of it is shown. The server's batching stays as it
  is. Text already there when the page loads, and everything under reduced motion, shows at once.
- The chat sticks to the bottom while the learner is at (or near) it: new text, the reveal,
  late-rendering blocks and a growing composer keep the latest line above the composer. A learner
  who scrolls up to reread stays put, with a "Jump to latest" button; sending goes to the bottom.
  Scrolls glide, except under reduced motion.
- Labels for work in progress ("Thinking…", the activity line, "Checking your answer…") shimmer: a
  band of light sweeps through the letters themselves, never outside them; plain text under reduced
  motion, and never on finished text.

### 9.4 Phones (requirements; not prototyped)

- Sidebar becomes a drawer.
- The gutter timeline disappears; a compact "step 2 of 5" jump menu goes in the top bar.
- Margin cards become highlights you tap, opening a bottom sheet.
- The check card stacks vertically below ~600px, with full-width touch targets (the prototype's check
  card is not responsive — fix in the real component).
- Building homework is a desktop activity; reading, checks and asides must be good on a phone.

## 10. Operating without an admin page

- Allowlist: `pnpm invite a@b.com`, `pnpm revoke a@b.com`.
- Model list: `models.config.ts` in the repo, reviewed with its eval results.
- Importing a track from the earlier setup (Omer's `Learning` folders, a one-time move):
  `pnpm import-track <track folder> --email <learner> [--title <title>] [--write]`. A dry run by default:
  it prints the track, term counts per status, dependencies, arcs, fix-list, the open threads, the owed
  homework and the last lesson found, and writes nothing. The ledger is parsed without a model: every
  row and item of Assumed, Confirmed, Taught and Planned becomes a term in its own wording, with the
  row's evidence ("Held before teaching (probe)" plus any note label for assumed; the context, such as
  "from S6", for planned); a name listed twice keeps its strongest status (confirmed > taught >
  assumed > planned) with the other evidence appended. The report shows the parsed counts per section
  next to the resulting term counts. One call to the learner's strong model (purpose `import`,
  streamed with its own 30-minute limit, strict structured output) only reads: given the numbered
  terms, the map, the plan and the open threads, it answers by term number with the dependencies, the
  arcs, the open misconceptions for the fix-list, and a few lines of plan notes. Numbers that name no
  term are left out and reported, as is an edge that would close a dependency cycle; only an
  unparseable reply is asked again (at most 3 calls), and a provider failure stops. The edits are then
  built the way a session's are (language English, every term as a planned term in dependency order
  with what it rests on, the statuses with their evidence, the plan, the fix-list) and must validate
  against an empty track. The dry run saves them to `.imports/<slug>.json`; `--write` applies exactly
  that file without a model call, and refuses if the earlier setup's files changed since. The model's
  plan notes get the state's open threads, owed homework (full text, as typed homework doesn't exist
  yet), the planned terms' ledger context, plan, session log and handoff appended verbatim. Only the latest lesson comes along, stored as its original HTML in `imported_lessons` and
  shown on the track page in an `<iframe sandbox>` with no scripts or same-origin access; older lessons
  are not imported. Refuses a learner without a key or a duplicate title.
- Everything else through the database directly, with care.

## 11. Eval harness (`tools/eval`)

A test suite for AI models, not personalization. A fixed strong model plays scripted learners from
persona files (cold start, warm start, a misconception, "I don't know" — shaped by Omer's manual
ChatGPT transcripts). The candidate model runs the real session phases; the **production validators**
plus a judge model score the transcripts: untaught terms, the probe teaching, scaffolding words,
stacked questions, check length, parse failures, diagram validity. Runs before a model joins the list
and whenever `method.md` changes. Built after the first working session.

## 12. Security and privacy

- HTTPS; least-privilege database roles; backups.
- Keys: §4.3. Content: never in logs (§4.2) or error reports; no content-reading UI.
- A plain sentence at sign-up: what is stored (answers, progress, questions, the encrypted key), that
  nothing is shared, and that the operator can technically access the database but does not read it.
- Model output is never rendered as HTML or run as code; every URL is verified before display.

## 13. Settled since the grilling

- Product name: **Grounded**.
- Omer's manual ChatGPT test of `test/method.md`: passed.
- The method changes in §3.2: approved.
- Cost: Omer's measurement puts it at minimal with GPT-6 Luna; acceptable to proceed. Per-model cost is
  still recorded (§4.4) and reviewed as the model list grows.

## 14. Order of work

1. `method.md` at the repo root: the tested chat-app version adapted to the app (phase tags, the §3.2
   changes, what the app provides in context and what the model returns).
2. Repo setup: git, pnpm workspaces, lint/format/test tooling, CI, Docker, Postgres locally.
3. `packages/content`: block-tree types, parser, allowlists, validators (with tests); renderer
   components in `apps/web` (shadcn + our tokens), starting from the prototype's verdict.
4. Auth (allowlist + magic link), key entry with envelope encryption, provider adapters, usage logging.
5. One track, one session end to end: phases, probe/plan chat, lesson generation pipeline, inline
   checks with repair and the gate, close with structured state edits.
6. Asides in the margin.
7. Homework (typed kinds, Tiptap, images, review on submit, Later/snooze), arc exams, the final.
8. Learner profile, per-track stats, usage display.
9. Eval harness; fill the model list.
10. Phone pass; deploy; invite the first people.
