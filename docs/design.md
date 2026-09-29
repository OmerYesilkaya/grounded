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
- Tracks (created and deleted by the learner); the full session loop (probe → plan → lesson →
  inline checks → homework → close).
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
  Claude Code specifics generalized. A chat-app version (`test/method.md`, since removed) passed Omer's manual
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
| The page is read in full, then checks in chat      | **Inline checks at the point of need (§7.3); the steps after a check unlock when it lands**                                                                                    | Restores the safety net the method lost when the terminal couldn't host both ("a bad step was caught by its check before anything was built on top of it") |
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
- **The review** (decided 2026-09-29, #52; `packages/core/src/review.ts`, `engine/review.ts`): one
  structured call to the cheap model (purpose `wording-review`, little reasoning) per text a learner
  reads — a chat message, an answer in the margin, a check's reply with its fresh question, a lesson
  step — made after the exact checks. It is given the ambiguous words flagged in it and the whole
  term list by name (held, and not held yet; a lesson's words given so far count as held), and
  returns, per flagged word, whether it is machinery where it stands, and any domain term the text
  uses that the learner doesn't hold and the text doesn't explain there. Those come back as errors
  (`scaffolding/judged`, `term/judged`) and are fixed with the exact ones, in the same rewrite:
  a chat message and a check's reply once, a lesson step with its rewrites. A lesson step is judged
  only once it is otherwise sound, and one the review still objects to after its rewrites is kept as
  written (logged with the judged codes): the review can hold a text back for a rewrite, never fail
  a lesson. A review that fails finds nothing. A text under 25 words with no flagged word isn't
  reviewed (`REVIEW_MIN_WORDS`): "That's it." has no room for jargon, and the learner is waiting.
  Cost: ~4,600 input tokens on the imported track's 204 terms (§4.4, the budgets), about half a
  cent on Haiku; latency: one cheap call before a text is stored or a step is released.
- **The same validators are the eval harness's scorers** (§11), so "which models are allowed" is
  measured by the checks that protect learners every day.

## 4. Architecture

### 4.1 Monorepo

pnpm workspaces, TypeScript end to end.

```
apps/
  web/          Vite + React SPA, shadcn/ui (Tailwind + Radix), Tiptap, TanStack Router/Query
  api/          Hono on Node: HTTP + SSE, auth, job enqueueing (`src/server.ts`); the job runners
                (lesson generation, grading, reviews, profile refresh) in `src/engine`, run by the
                worker process (`src/worker.ts`); lesson media found and verified (`src/media`);
                the CLI (`src/cli.ts`: `pnpm invite`, `pnpm revoke`) and the track import
                (`src/import`, `pnpm import-track`)
packages/
  core/         method phases and the session state machine, prompt assembly, validators, domain types
  content/      block-tree types, markdown→tree parser, per-surface allowlists, validation (shared by web, api, worker, eval)
  providers/    Vercel AI SDK adapters (Anthropic, OpenAI, Gemini), model list config, usage accounting
  db/           Drizzle schema and migrations
  crypto/       envelope encryption behind a KeyVault interface
tools/
  eval/         eval harness: personas, the session driver, counts and the judge, reports (§11)
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
  (unless its check job is still queued), so does a question in the margin still waiting for its
  answer ("… Ask again", in its card, unless its aside job is queued), and a lesson that stopped
  being written, outlined or not, is marked failed (unless its job is still queued); each such
  session gets an `error` event (not for an aside alone: its card already says so).
  A lesson job that fails for any reason (the provider included) marks its lesson failed itself
  before telling the learner why, so an unfinished lesson is always one whose job died, and a failed
  one is never reported twice.
  Nothing is re-run: jobs are attempted once. A check job grades only an answer still waiting, so
  one that starts late never contradicts recovery. Running recovery again changes nothing.
  **Recovery also runs every minute in every worker** (`recoverPeriodically`, #22), so a worker that
  dies while others keep running is cleaned up after within about a minute. It is cheap: it takes
  only free locks, so it never waits on a job. It leaves a session with an event in the last 30
  seconds for a later run: a request may be between recording work (an answer to grade, an approved
  plan's lesson) and queuing its job, which holds no lock, and every such request publishes an event
  first. A worker that loses the connection holding its locks exits (its running jobs are no longer
  protected), and the others' recovery cleans up after it; Railway restarts it. In development
  `pnpm dev:worker` runs it under a small supervisor (`src/dev/worker-dev.ts`) that restarts it when
  the code changes, as `tsx watch` did, and also when it stops, which `tsx watch` wouldn't; one that
  fails within seconds of starting waits for a change instead.
- **A failed lesson can be written again** (`engine/lesson-again.ts`). A lesson fails when its job
  dies or fails (above), and also when a step is still broken after its rewrites: the lesson can't
  go past a step that isn't there, so it isn't left "ready" with a hole in it. The steps written
  before the first missing one stay readable and their checks answerable (the web shows only those:
  what comes after the gap rests on it). The learner then picks **Write the rest again**, which keeps
  the outline and those steps and writes the rest on the same outline, from the first step missing
  (the writing prompt carries the steps already written), or **Start the lesson over**, which writes
  a new outline and every step. A lesson that failed with no step written offers only the second,
  as "Write the lesson again". What the dropped steps had (their text, check threads, notes) goes
  with them; a `lesson-again` event tells the browser which steps are kept. It is done only while no
  job works on the session (the recovery lock), and the lesson job it queues starts once it is done;
  the job writes the rest when the lesson has an outline and is `ready`, and the whole lesson
  otherwise. A request that fails part-way is simply sent again: every write before the state change
  can be made twice.
- **A job the learner can't set going again by writing can be tried again** (`engine/retry.ts`,
  `awaitedJob` in `packages/core/src/session.ts`; #21). Those are the probe's turn (the opening
  question, or the one after the learner's answer: the composer waits for the tutor), a plan being
  written or revised, the homework being written and the recap (an assigned homework waits for the
  learner, not a job). When the one the session waits on failed, or died
  with its worker, nothing is queued for it and nothing runs: the session is **stalled** (the
  snapshot says so, and the job's `error` event), and the chat shows the error, or "The tutor
  stopped before finishing" after a reload, with **Try again**, which queues the same job again.
  Like writing a lesson again, it is done only while no job works on the session, so two clicks
  queue it once. The homework and the recap are kept once written: a homework job tried again
  after its message only records it (and after its record only assigns it), and a recap job tried again after a failed sweep goes on from
  the recap the learner has read. The lesson's own jobs have their ways back: an answer again for
  a check, and writing the lesson again.
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
  **The one exception, `LOG_CONTENT=true`** (off by default; an operator's switch, production
  included, for diagnosing what a model was asked and answered): every model call's line then also
  carries, under `content`, the prompt's message count, its last turn (the instruction, the answer
  or a retry's feedback; the system prompt and earlier turns are left out), whether it asked for
  JSON, and the reply (text, reasoning, tool calls), a failed call's as far as it got. Rejected track
  edits carry their reasons and the batch, a rewritten chat message its issues' messages, and errors
  keep the messages that quote content. Keys and tokens stay out regardless. Turn it on for a
  deploy, reproduce, turn it off: while it is on, the log holds learners' words.
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
- **Rate limits per client:** Better Auth's limits (5 magic links a minute) key on the client's
  address, the last `X-Forwarded-For` hop before the host's proxies (`TRUSTED_PROXIES`; Railway's are
  `100.0.0.0/8`). Without it every client shares one bucket, so one person could lock out everyone.
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
- **Model list in code** (`packages/providers/src/models.ts`), each entry next to its eval results.
  Adding a model is a reviewed change. Learners pick from the list for their provider; no free-form
  model ids.
- Roles per provider: a **strong** model for planning, lessons, check grading and homework review
  (a wrong verdict costs more than a few cents); a **cheaper** model for asides and small jobs.
- **Research** replaces the `researcher` subagent: during planning (scoping the field, seeding planned
  terms) and whenever a fact is uncertain, the model runs with the provider's search tool on and
  returns notes with sources, stored on the track (`research_notes`, `engine/research.ts`; decided
  2026-09-29, #53). It is always a call of its own, never a tool beside others: a search can't take
  the place of the plan or the outline, and Gemini can't combine its search with function tools
  (the outline's `find_image`). Two calls research: the first plan (scoping the field, as before)
  and every lesson's outline (§7.2). The lesson's is asked to search only what it isn't sure of
  (names, dates, figures, quotes, how a mechanism really works) and to reply "Nothing to check."
  otherwise, so the model's own doubt decides when to search: "only when the outline says a fact is
  uncertain" would cost an outline written twice, and a model that is wrongly sure never says so.
  Notes are stored only when a search ran (notes without one are memory), with the queries. A
  session's notes go to its later calls that need them: the plan's to the plan, both to the lesson's
  outline and writing (the plan's research had reached only the plan) and to a lesson written again,
  which searches nothing. Other sessions don't carry them: what matters of them is in the plan's
  notes; the stored notes are the sources behind the facts (for the eval's judge and a track page
  later). A lesson's research that fails is logged and the lesson is outlined without it. Research
  runs on the strong model under the lesson's time limits, before "Outlining the lesson", as
  "Checking the facts the lesson needs", with each search shown.
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
- **The usage page** (`/usage`, from the account menu; `GET /api/usage`, `apps/api/src/routes/usage.ts`;
  decided 2026-09-29, #46) shows an **estimated cost** first, tokens second: a learner pays in money,
  and a token count means little to them. Cost is computed at read time from the model list's prices
  (`estimateCost`), so a price fixed later corrects the past too; a model with no price yet is
  counted as "not counted: N calls" rather than guessed. Each call records its track and session
  (`ModelRequest.sessionId`) and its cache writes (`cache_write_tokens`, billed by Anthropic at 2x
  input for the 1-hour lifetime, so the model list carries a `cacheWrite` price). The page shows this
  month so far (in the browser's time zone), the earlier months (the last 12) and the 30 most recent
  sessions, each linking to the session; failed calls count, as providers bill them. It says the
  figure is an estimate and the provider's bill is exact.
- **Prompts are ordered stable-first** (`assembleSystemPrompt` in `packages/core/src/prompt.ts`), so
  a provider can reuse the cached start of the previous call: the method's `all` sections (the same
  for every phase; `method.md` keeps them all at its top, so they are one leading run), then the
  phase's own method sections, then the track's slowly changing state (subject and language, plan,
  term list, borrowed terms, for the plan's calls what the other tracks hold, fix-list, teaching
  notes, in that order), then what only this call
  carries (the step being checked, research notes, the probe's conclusion), then the conversation.
  The track's state renders the same way on every load (terms and fix-list in creation order, what
  a term rests on in the term list's order), so two calls of a track and phase are byte-identical
  up to their own parts, and two calls of different phases through the all-phase sections (decided
  2026-09-28). Where a line lists several terms (what a term rests on, an arc's terms) they are
  set apart by " · ", not commas: a term imported from long notes may hold commas and semicolons
  of its own ("index; B-tree (…); measured 4 levels at 10M, 5 pages per lookup"), and a model
  reading a comma-joined list took two terms for one or one for two (#27).
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
    `WHOLE_PLAN_PHASES`) see every arc's terms: the plan's record to place its new terms in the arc
    they belong to, the close and the final because their `set-plan` replaces the arcs.
- **"Where you left off" stands in for the plan's notes** (`tracks.left_off`, decided 2026-09-28,
  #13; `apps/api/src/engine/left-off.ts`). The plan's notes as written (34 KB on the imported
  track) stay in the database and go only to the close: the recap and the term sweep read them,
  and the sweep changes them a section at a time (`edit-plan-notes`, §5). After the sweep, one
  more call (`left-off`, little reasoning) writes the summary from the
  notes as the sweep left them and the whole session: open threads, owed work, what to re-check,
  where the next session picks up, in about 300 words. Every other call carries it, under the
  plan's arcs. The plan's record saw only the summary, so its notes (`add-plan-notes`) are added
  after the notes under "Noted while planning" (one heading for all of them until the next close),
  for the next close to fold in: the sweep's request says to move them into the sections they
  belong to and remove that section.
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
  the notes as written). The term sweep then got the session's conversation too (#17): ~19,900 →
  ~22,000, about what the recap sends. Budgets sit about a fifth above: probe 12,000, plan 20,000 (17,000 until the plan carried up to 300 terms held in other tracks, #54: ~15,000 → ~17,200), lesson and
  homework 12,500, check 10,000, close 25,000. The method's sections are now the largest part
  (18–24 KB per phase), and they are the part every call reuses from the cache. An aside (#37)
  carries the whole lesson: ~13,300 with six steps of a real one's size (about 20 KB) and two
  earlier asides, budget 16,000. The wording review (#52, §3.3) carries the whole term list by name
  and one text: ~4,600 for a probe question, budget 7,000.
- **Cache hints** are added in the model middleware (`shapeCall` in
  `apps/api/src/engine/call-options.ts`), from the request's `trackId`. OpenAI: `promptCacheKey` is
  the track id, so a track's calls reach the same cache. Anthropic: the system prompt is sent as one
  block per part, with a cache breakpoint (`cacheControl: { type: "ephemeral", ttl: "1h" }`) after the
  all-phase method sections (about 16 KB of the 18–24 KB, shared by every phase's calls: a check
  reuses what the lesson before it cached), after the phase's own sections and after the track's
  state, and the top-level `cacheControl` caches the whole prompt for the conversation's next call.
  That is 4 breakpoints, Anthropic's maximum per request (more is an error); the top-level one
  counts, though `@ai-sdk/anthropic` counts only the marks on blocks, so the limit is kept in
  `call-options.ts` (`MAX_CACHE_BREAKPOINTS`): an empty part gets no block and no mark, and the
  top-level mark is left out when a prompt already carries 4. Every breakpoint lives an hour
  (decided 2026-09-28): a learner's calls are often more than the default 5 minutes apart (reading
  a step, working out an answer), and each read renews the hour. A cache write then costs 2x base
  input instead of 1.25x (a read stays about 0.1x), so a prefix pays off from its third use. All
  breakpoints share the lifetime because Anthropic requires longer-lived ones before shorter ones;
  the 1-hour TTL needs no beta header. Google caches implicitly. For OpenAI and Google the parts
  are joined back into one system message, so every provider reads exactly the assembled prompt.
- **Reasoning effort per purpose** (`REASONING` in `apps/api/src/engine/call-options.ts`), set in
  the same middleware through the AI SDK's provider-neutral `reasoning` option (OpenAI's reasoning
  effort, Anthropic's thinking effort or budget, Gemini's thinking level). The small structured
  records of what the conversation already showed think little (`low`): the probe's decision
  (`probe-decision`, its own purpose, apart from the probe's question and from `probe-summary`, which
  writes what the probe found once it is finished and keeps the default, since the plan is built on
  it), the close's term sweep (`term-sweep`, apart from the recap) and an aside's record
  (`aside-record`, apart from its answer), the wording review (`wording-review`, §3.3), and so do
  the summaries of what is already written ("where
  you left off", `left-off`; a long session's older turns, `conversation-summary`). Everything else
  keeps the provider's default, above all plans, lessons and check grading.

### 4.5 Files (decided 2026-09-28)

- **Learners' files live in a file store** (`FileStore` in `apps/api/src/files/store.ts`); the
  database holds what each file is. Production: an S3-compatible bucket (a Railway bucket, whose
  `BUCKET`, `ENDPOINT`, `REGION`, `ACCESS_KEY_ID` and `SECRET_ACCESS_KEY` the services reference as
  `FILES_*`; virtual-hosted URLs unless `FILES_FORCE_PATH_STYLE`). Development: a folder (`.files`
  at the repo root, or `FILES_DIR`). Tests: memory. Production refuses to start without a bucket,
  since a container's disk doesn't outlive a deploy. MinIO was the first choice for development and
  was dropped: its community images stopped in October 2025. Keys are made by the app
  (`tracks/<track id>/<file id>`), never from a file's name.
- **What can be attached** (`@grounded/core/attachments`, shared by the web, which checks as
  files are added, and the API, which checks again and decides): images (PNG, JPEG, WebP, GIF, at
  most 5 MB each, Anthropic's per-image limit), PDFs, Word documents (.docx) and text files (.txt,
  .md), at most 10 MB each; at most 8 files and 20 MB together; the PDFs at most 50 pages together
  (providers take 100 per request, and a track's PDFs ride in the same calls). A file is what its
  contents say, not its name: image and PDF signatures are checked (an image's media type comes from
  its bytes), text must be UTF-8, a PDF must open and not be password-protected. Word documents and
  text files are sent as their text (at most 50,000 characters each, taken out with `mammoth` for
  Word and stored in `track_files.text`); images and PDFs go to the model as they are.
- **Creating a track with files is one request** (`POST /api/tracks` as a form, `goal` and `files`;
  JSON `{ goal }` without files), bounded by a body limit. The bytes are stored first, then the track
  and its `track_files` rows in one transaction; if anything fails, the bytes already stored are
  deleted again. Files can only be added when the track is created, for now.
- **How the tutor reads them** (`apps/api/src/engine/brought.ts`). The first session's probe and
  plan (research included) read the files themselves: the opening turn carries them after the
  learner's words, images and PDFs as file parts, Word and text files as their text. Every other call
  carries "what you brought" in the track's part of the prompt (after the subject): the files' names
  and a summary of about 300 words (`tracks.brief`) of what each file is and what it shows the learner
  knows, has done and wants to reach, with the specifics to build on. The summary is written once,
  by a job queued when the track is created (`track-brief`, the strong model with little reasoning),
  while the first session is reading the files anyway. If it fails, a later session's opening writes
  it first ("Reading what you brought"); if that fails too, calls carry the names and say the
  contents aren't known. The first session's lesson and later calls carry it without its files, so
  the phase budgets (§4.4) hold: the budget fixture carries a summary of about 3,300 characters.
- **A learner can download their own files** (`GET /api/tracks/:id/files/:fileId`), always as an
  attachment with `nosniff`, never shown inline.
- **A learner can delete a track** (decided 2026-09-29, #26; `DELETE /api/tracks/:id`,
  `deleteTrack` in `apps/api/src/files/track-files.ts`). The track row goes, and by cascade
  everything in it: sessions with their messages, events, lessons and check threads, terms and their
  events and edges, the fix-list, research notes, `track_files` rows, the imported lesson. Then its files' bytes are
  deleted from the store, which the database can't reach; rows first, so no row ever names bytes
  that are gone, and bytes that can't be deleted are logged and left, reachable by nothing.
  `usage_events` stay: they belong to the learner, not the track, and record what was spent.
  **A job on the track** (a lesson being written, a check being graded, the track being named) is
  not waited for or cancelled: one still queued doesn't start, and one running stops at its next
  write, since what it adds has nothing left to belong to, and ends as done rather than failed,
  nobody being left to tell (`apps/api/src/engine/gone.ts`). The model call in flight still
  finishes and is paid for; it is recorded in `usage_events` like any other.

## 5. Data model

The schema is `packages/db/src/schema.ts`. Tables that exist:

| Table                                            | Holds                                                                                                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `users`, `sessions`, `accounts`, `verifications` | Better Auth's: account, sign-in sessions, magic-link tokens                                                                                            |
| `allowlist`                                      | who may sign in                                                                                                                                        |
| `credentials`                                    | provider, encrypted key, credential source                                                                                                             |
| `tracks`                                         | name (and whether the tutor is still naming it), learner's words, "what you brought", language, plan (arcs and notes, below), left off                 |
| `track_files`                                    | per track: the attached files' name, kind, media type, size, PDF pages, text, file store key                                                           |
| `terms`                                          | per track: term, status (`planned`/`taught`/`confirmed`/`assumed`), topic, the term it is borrowed from                                                |
| `term_events`                                    | evidence history: status change, quoted learner words, source (check, homework, aside, exam)                                                           |
| `term_dependencies`                              | "rests on" edges — the map; source of every structure picture                                                                                          |
| `fix_list_items`                                 | the audit's misconceptions and their status                                                                                                            |
| `learning_sessions`                              | track, kind (normal / final), the state machine's state (phase, plan, lesson, steps), open/closed, probe summary, older turns summarized               |
| `session_messages`                               | the session chat (probe, plan, homework, recap): the learner's text, the tutor's block trees, a plan's terms                                           |
| `session_events`                                 | the session's ordered event log, replayed by SSE (§4.2)                                                                                                |
| `lessons`                                        | per session: the outline, each step's block tree and markdown, failed steps, "after the check" notes, what the learner already held                    |
| `check_messages`                                 | per step: answers, verdicts, repairs, fresh questions                                                                                                  |
| `research_notes`                                 | per session: what the web search found (the first plan's scoping, a lesson's facts), with the queries                                                  |
| `asides`, `aside_messages`                       | questions on a lesson passage (its block id, the quote and the text around it), their threads, a tangent to save                                       |
| `usage_events`                                   | per model call: purpose, model, tokens (cache reads and writes), duration, its track and session                                                       |
| `imported_lessons`                               | per imported track: the last lesson of the earlier setup, original HTML, shown read-only (§10)                                                         |
| `learner_profile_notes`                          | per learner: teaching notes (§8): text, evidence (session and what showed it), created/revised at, whether the learner wrote or edited it              |
| `profile_refreshes`                              | per learner: each refresh of the teaching notes and the close it ran at, changed or not                                                                |
| `assignments`                                    | homework (an arc exam later, #42): its session, kind, name, its tasks (each's answer kind and blocks), "what a good answer demonstrates", handed in at |
| `submissions`                                    | per assignment: the learner's answers, saved as they write: each task's fields as markdown, and when a prediction was locked                           |
| `answer_files`                                   | pictures in the answers (a photo of a notebook page): media type, size, file store key                                                                 |

An assignment also holds when it is snoozed until (`snoozed_until`, "Later") and the later homework
it was folded into (`subsumed_by`), §7.4.

Planned for v1, not built yet:

| Table     | Holds                                                                        | Issue |
| --------- | ---------------------------------------------------------------------------- | ----- |
| `reviews` | margin comments on a submission, checklist outcome (held / leaked / missing) | #39   |

Which session closes each arc isn't recorded yet (#42).

The model never rewrites state. It returns small structured edits (promote term X with this evidence,
add planned term Y resting on Z, close fix-list item N) that the server validates and applies.

**`add-planned-term`** `{ term, restsOn }` adds a planned term resting on terms already in the list
(or added earlier in the batch). For a term already in the list it is idempotent (decided
2026-09-29, #19): the term keeps its status and gains the `restsOn` edges it lacks; nothing else
changes and no event is recorded. Prompts show only part of the term list (§4.4), so a plan may
plan a term that exists but wasn't shown; that used to reject the plan and cost a retry. The plan's
record request says so. Everything it rests on must still be in the whole list.

**Borrowed terms** (decided 2026-09-29, #54): a term the learner holds in another of their tracks
is borrowed, usable here as held and not taught again (method.md, "Borrowed terms").

- **The model proposes, the server checks.** Exact names can't decide it: a word means different
  things in different subjects ("state" in history and in programming), and a track taught in
  another language names the idea differently. So the plan's calls carry what the learner holds in
  their other tracks (confirmed or assumed there on that track's own evidence; the most recently
  active tracks first, at most 300 terms, `HELD_ELSEWHERE_LIMIT`), under "Held in the learner's
  other tracks", and the plan's record borrows with **`borrow-term`** `{ term, from }`: `term` as this
  track names it, `from` as the other track spells it. It is rejected (`not-held-elsewhere`) unless
  another of the learner's tracks holds `from`, checked against all of them. Borrows are applied
  first in their batch, so a planned term may rest on one borrowed later in it.
- **A borrowed term is a row of this track's term list** (`terms.borrowed_from`, the term it came
  from), not a table of its own: what rests on it, the map and every validator then work as for any
  term. Its status is `confirmed`, with the event "Held in "Operating systems" (as "thread")." It
  can borrow a term that is only `planned` here; a term with a status of its own here keeps it.
  Prompts list borrowed terms apart, as they are now (the plan borrows once a session, as the plan
  changes), under "Borrowed terms" with the track and the other name; the validators see them as
  `borrowed`, a held status.
- **It doesn't hold here → demoted here only.** Any status recorded for a borrowed term makes it
  this track's own (the link is cleared). When it goes back to `taught`, the track it came from keeps
  its status, which was earned there, and hears why: its term gets an event with its status
  unchanged ("Didn't hold in "How software works", which borrowed it: …"), which also counts as a
  recent touch there, so that track's next sessions list it. A borrow is taken as it was: a term
  later demoted in its own track is not demoted where it was borrowed.

A rejected edit is never dropped silently (decided 2026-09-29, #16). `validateActions` checks a batch
against the track as each edit leaves it and returns, per rejected edit, its index, a reason the
model can act on and a code (`unknown-term`, `no-evidence`, `unknown-rests-on`, `no-open-fix-item`,
`no-language`, `empty-arc`, `unplaced-term`, …): logs carry the codes and edit types, never the
reasons, which quote term names. Only valid edits change the shape it checks against, so an edit
that needs a rejected one (a status for a term whose adding was rejected) is rejected with it and
the rest is still a valid batch. What each caller does with a rejection:

- **The probe's decision and a check's verdict** (`applyValidActions`): the edits ride along with
  the call's real work, so what validates is applied at once, and the rejected edits go back to the
  same call once, with the reasons ("send these again, corrected, and only these"); what validates
  of its answer is applied too, and anything still rejected is logged and left out. Asking again is
  best-effort: if that call fails, what was applied stands. It runs only when something was
  rejected, under the call's own activity label.
- **The plan's record** is all or nothing (`applyActions`): a plan that can't be recorded is
  retracted and presented again with the reasons, since the learner approves the plan as shown.
- **The close's term sweep** is all or nothing with the reasons fed back, up to three attempts; the
  last attempt applies what validates, so a bad edit doesn't cost the rest of the sweep.
- **An import** is all or nothing: its edits are built to be valid.

The plan (`tracks.plan`: arcs `{title, terms}` in order, and notes) changes through these edits
(`apps/api/src/engine/track-state.ts`):

- **`add-to-arc`** `{ arc, terms }` appends terms to the arc with that title (matched
  case-insensitively), or, when no arc has it, adds a new arc with them at the end. It never removes
  or reorders anything. Every term must be in the term list as the whole batch leaves it (so it may
  come before the `add-planned-term` that adds it); an arc with no terms is rejected. A term already
  in an arc, this one or another, stays where it is and is skipped (logged, not rejected): a term
  belongs to one arc, moving it is a rewrite, and a revised plan that places the same terms again
  changes nothing. If every term is skipped, no arc is created. Terms are stored in the term list's
  spelling.
- **`set-plan`** `{ arcs, notes }` replaces the arcs, and the notes unless `notes` is null (the
  close changes the arcs this way and keeps the notes as they are). Only a call that saw all of it,
  every arc's terms and the notes as written, may send one: the close's term sweep (and the final's
  audit), and an import (`rewritePlan` on `applyActions`). From any other call it is left out,
  logged, and the rest of the batch applies.
- **`edit-plan-notes`** `{ heading, text }` changes one section of the notes (decided 2026-09-29,
  #18), so the close doesn't write 34 KB of notes again to change a line, or drop one by accident.
  A section is a heading line and everything up to the next heading of its level or above (its
  subsections with it); headings inside code fences don't count. `heading` is the section's heading
  line as the notes write it ("## Open threads"), matched ignoring case and runs of spaces. `text`
  replaces the body under the heading (kept as written); null removes the section; a heading no
  section has adds a new section at the end. Rejected: a `heading` that isn't a heading line
  (`not-a-heading`), removing a section that isn't there (`no-section`), and a heading more than
  one section has (`ambiguous-section`: the reason says to edit the section that holds the one
  meant). Allowed from the same calls as `set-plan`; edits in a batch apply in order, after a
  `set-plan`'s notes when it has them.
- **`add-plan-notes`** `{ notes }` adds notes after the plan's notes (above).

Which call is offered which edits (`packages/core/src/actions.ts`): the probe's decision, a check's
verdict and an edit asked for again (`trackActionSchema`) get the term, fix-list, language and
`add-to-arc` edits; the plan's record adds `add-plan-notes` and `borrow-term`; the close's sweep
(`closeActionSchema`) adds `set-plan` and `edit-plan-notes`.

**A session's plan never rewrites the plan** (decided 2026-09-28, #23). Its record (`planActionsSchema`)
isn't offered `set-plan` at all: it adds its planned terms and places this session's new ones with
`add-to-arc`, each in the existing arc it belongs to by that arc's exact title, and a new arc only
for terms none fits; the rest of the plan stays as it was. A track's first session has no arcs, so
its plan names the first ones. Reordering, merging or retiring arcs is the close's job, which sees
the whole plan and notes. (Before this, the plan's `set-plan` replaced the arcs, so from the second
session on an approved plan dropped every arc it didn't restate: the imported "How software works"
lost arcs A–D to one arc, "SQL as asking questions".)

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
| audio                                         | Commons audio (music samples, instruments, pronunciation) through `find_audio` — "audio when needed"                                                                                                                                                                              |
| link card                                     | anything else from sources: title, site, one-line reason                                                                                                                                                                                                                          |
| check                                         | the step's question; answered and graded inline                                                                                                                                                                                                                                   |
| word card                                     | `:::word{term="…"}`: a word the learner doesn't hold, and what it means in words they do, given before the lesson uses it (below)                                                                                                                                                 |
| preview card                                  | `:::about{name="…" track="…"}`: a person, place or work the lesson leans on, in a paragraph at most; `track` offers a track of its own (below)                                                                                                                                    |

v2: runnable code (JS in a Web Worker, Python via Pyodide — browser only, never on our servers),
generated sound (the model writes notes, the browser plays them), function plots, other interactives.

**Word cards** (decided 2026-09-29, #24). In prose a new word is easy to read past; a card marks the
moment it is given. Whoever spent a year hearing "ontology" and "epistemology" without being told
what they mean knows the cost.

- **One card per term a step introduces** (the outline's `introduces`), in that step, before its
  first use. The step's heading counts as a use, so a heading names the idea, not the new word. The
  card holds the word and what it means in a sentence or two of text (maths allowed; no drawings).
- **Validated with the step** (`taughtHere` in `validate`): a term the step introduces is untaught
  until its card and usable from it on, the card's own definition included, so the definition uses
  only words the learner holds (and the step's earlier cards). Errors, rewritten like any other:
  used before its card (`word/before-card`), no card (`word/missing-card`), a card for a word the
  learner holds (`word/held`) or for a term taught in another step or lesson (`word/not-here`). A
  card for a word the track doesn't list (a label the lesson coins, method rule 3) is allowed. A
  card is found for a long imported term by its name up to a ":", "(" or ";".
- **The card marks its term taught, server-derived** (`markCardsTaught`, `engine/word-cards.ts`):
  the lesson has no structured call to promote it, and a model shouldn't have to remember. It is
  marked once the learner can read the step (it is written and every check before it resolved), not
  when it is written: a learner who pauses never sees the steps behind the check, and nothing moves
  a term back to `planned`. Only a `planned` term moves; the evidence is the card ("Given its word
  card in the lesson: …"), source `lesson s2`. Run after each step is stored, after a check's
  verdict and after "Continue anyway". The check then confirms it as before.
- **Lesson only.** Asides, repair threads and homework change no status and teach no new word; a
  repair re-teaches a word the lesson already gave.
- **The glossary** (`ValidateContext.glossary`: jargon of the track not in the plan, never usable
  untaught) is separate and not yet filled by anything. A card never adds to it: a carded word is a
  term-list term. The cards themselves, with their definitions in `term_events`, are what a
  learner-facing list of words would be built from.

**Preview cards** (decided 2026-09-29, #24). "Kant's ideas were regarded highly in those times"
leans on who Kant was, which no definition gives and which isn't taught the way a term is. A
`:::about{name="Immanuel Kant"}` card says who or what it is, when, and why it matters here, in one
paragraph (`about/not-one-paragraph` otherwise); its text obeys the term list like prose. When there
is more to it than a preview, the model adds `track="…"`, the goal of a track of its own ("Kant:
what he held and why it mattered"), and the card offers **Make a track about this**: the new-track
page (`/tracks/new?goal=…`) in a new tab with the goal in the box, so the lesson stays where it is
and the learner edits or creates it themselves. It records nothing about the learner. Allowed in
lessons and asides.

### 6.3 Per-surface allowlists

| Surface                    | Allowed                                                                                               |
| -------------------------- | ----------------------------------------------------------------------------------------------------- |
| Probe and plan chat        | text-like only: paragraphs, lists, quotes, code, maths, tables (the plan picture is drawn by the app) |
| Lesson                     | everything, and the only surface with checks                                                          |
| Aside card                 | text-like blocks plus diagram, stepper and preview card                                               |
| Repair thread, review card | text-like blocks plus diagram and stepper                                                             |
| Homework prompt            | text-like blocks plus headings, diagram and media                                                     |

Code stays allowed in the chat because a probe question may need to show code in full ("what does
this print?"). The allowlists live in `@grounded/content` (`ALLOWED_BLOCKS`). A call that writes for
a surface is told its blocks (`allowedBlocksLine` in `@grounded/core`: the aside's answer, the
homework), leaving out what the call can't make: the homework has no tools to find media, so it is
offered videos and link cards to sources from the session, not images or audio.

"The probe teaches nothing" is then enforced by the renderer and validator, not just requested.

### 6.4 Validation and failure

- A block is shown only once complete and validated; a quiet placeholder holds its place meanwhile.
- Invalid content regenerates **only that step**, with the exact error fed back; after two failed
  retries it degrades (diagram → caption + "diagram unavailable"; media → link card). A structural
  failure (missing check) cannot degrade: the step fails, and with it the lesson, which the learner
  writes again from that step ("Write the rest again", §4.2).
- Every URL is resolved server-side before display; unverifiable media is dropped. How (decided
  2026-09-29, #51; `apps/api/src/media`):
  - **Media is found while outlining.** The lesson's outline call is offered `find_image` and
    `find_audio` (up to 8 tool rounds, the last without tools so it always ends in the outline).
    Each searches Wikimedia Commons (`filetype:bitmap|drawing` or `filetype:audio`, six results)
    and returns each file's ref (`commons:File:…`), what its page says it shows, its size or
    length and its licence; a file without a licence, or a recording no browser plays (MIDI), is
    left out. What they found is listed in the writing prompt and in each step's rewrite. The
    lesson itself is written by a call with no tools, as a chat message is (§7.1): a model that
    narrates its tool use ("let me find an image") would otherwise write that into the lesson.
    Each search shows as an activity ("Looking for an image of “…”"); a search that fails tells
    the model to go on without it. A lesson written again from a failed step keeps its outline,
    so it searches nothing; what it writes is verified all the same.
  - **Each step is verified once it is sound** (parsed and validated), before it is released:
    Commons images and audio are looked up (a ref the tools found is not asked about again) and
    the block stores the file it resolved (`file`: the URL the browser loads, a 1280 px thumbnail
    for an image and the MP3 version of a recording where Commons has one; its page; the author
    as plain text; the licence and its URL). The renderer shows the author linked to the file's
    page and the licence linked to its deed. YouTube videos are checked through the Data API
    when the worker has `YOUTUBE_API_KEY` (it exists, may be embedded, and start and end fall
    inside its length), otherwise through oEmbed (it exists and may be embedded; the times are
    checked only against each other). Link cards, inline links and a chart's source must open:
    a status below 400 after at most 5 redirects, HEAD first and GET when HEAD is refused.
  - **What fails is fed back like any other issue** (`image/unverified`, `audio/unverified`,
    `video/unverified`, `link/unverified`, `chart/unverified-source`), so the step is rewritten
    with the problem stated; after two rewrites the step is kept without it: a missing file,
    video or page is dropped, an inline link keeps its text, a chart keeps no source, and a video
    that exists but can't be embedded or shown between the times asked becomes a link card to it
    on YouTube.
  - **Verification results live for one lesson job, in memory**; no cache table. A URL used twice,
    or again in a rewrite, is asked about once; nothing outlives the job, since what it verified
    is stored with the lesson. Stored lessons are not re-verified later.
  - **Time limits:** 8 s for each API answer (Commons, YouTube) and 8 s for a page, redirects
    included; one that doesn't answer in time is unverifiable. Requests name the app in their
    User-Agent, as Wikimedia asks.
  - **Only the public web is reached:** a page is fetched only over http(s), and never at an
    address in a private, loopback, link-local, shared or reserved range, checked for the host's
    every resolved address and again at each redirect, so a model-written URL can't reach the
    app's own network.
  - Tests and the embedded backend use a web that answers nothing, or one the test makes up; no
    test reaches the network. The eval runs real models on the real web.
  - A chart carries its data inline: a spec with a `url` or `href` anywhere (data from a file, an
    image mark, a link on a mark) is rejected (`chart/external-data`), since those addresses are
    the browser's to fetch and nothing could verify them first.
  - **Chat messages and check replies** (text-only surfaces) have their links verified the same
    way before they are stored; one that doesn't open keeps its text, and the message isn't
    rewritten for it (the learner has already watched it being written). The app's own replies
    ("That didn't go through…") carry no links and aren't checked.
- Failures are logged per model and feed the eval (parse-failure rate is a gate metric).
- **Prefer top-to-bottom diagrams:** left-to-right Mermaid flowcharts shrink badly in a 68ch column
  (prototype finding). The prompt says so; wide figures may later break out of the text column.

## 7. The session

### 7.1 Phases

Server-owned state machine: **review → probe → plan → lesson (inline checks at the point of need) → homework →
close.** The model _proposes_ transitions through structured actions ("probing done; here is the
plan"); the server checks preconditions (a plan before a lesson; every check resolved before homework);
the learner approves at the gates (the plan), and moves the homework on (hands it in, or puts it
off with "Later", §7.4), after which the close runs. The learner can nudge at any time ("skip ahead to the
plan"). Sessions stay open indefinitely and resume where they stopped; **one open session per track**.

**Prose first, then structure.** A tutor message is streamed from a call with no tools, so a tool call
can never take the message's place; its actions and decisions (the plan's terms and arcs) come from a
separate structured call on the finished message. A reply without text is asked for again and never
stored. Before the first plan, research runs as its own call with the provider's search tool, and its
notes go into the plan's prompt.

**The probe decides first, then writes.** The session opens with the first probe question, written
from what the learner said they want to learn (their words as typed when they created the track,
`tracks.goal`, given in the opening turn with any files they attached, §4.5). Every
later probe turn starts with the structured call: what the answers showed (term evidence, fix-list
items, the teaching language) and whether probing is finished. If not, the next question is written
with those records in its prompt. If it is, no probe message is written: the session moves to planning,
and the plan job is the only place a plan can appear (a model that felt done used to present the plan
in its last probe message, leaving the plan message with nothing to say). Once the decision says
finished, a separate call at the default reasoning effort writes what the probe found — where the
learner's knowledge ends, and their goal — so the record the plan is built on isn't made by the
low-effort decision (the decision runs every turn; this runs once). It is stored on the session (`probe_summary`) and
given to the plan's calls, research included; when the learner skips ahead to the plan there is none.

### 7.2 Lesson generation pipeline

1. **Research, then outline**: research checks on the web what the lesson will state and the model
   isn't sure of (§4.4, a call of its own, searching only where it needs to); then the outline:
   the lesson's title (the idea it builds, as a tutor would name
   it; the track list shows it, §9.2), steps, the motivation for each, the terms each introduces and
   rests on, the drawings needed. Validated against the term list before any writing (`fitOutline`),
   and written in the term list's spelling. The app then places the checks from what each step rests
   on (`placeChecks`, §7.3), and the writing prompt says which steps end with one and what it covers.
   - **Terms are found as a model names them**: by the full name, or, when it names no other term,
     by a part of it (a semicolon-separated part, the words before a colon or a parenthesis), a
     fragment of it, or the name with more run on after it; two names copied as one (joined by the
     prompt's " · ") are two. A model shortens a long name, and a track imported from long notes has
     many (#27: Omer's outline was rejected three times over "requests table row" for "requests
     table row: one API request with api_key_id, tokens, and created_at").
   - **What the outline plainly means is settled, not sent back**: a held term named as introduced
     is what the step rests on; a `taught` term a step rests on before any step teaches it again is
     taught again there (the method re-teaches a taught term before using it; the outline prompt
     asks for this too); a name the term list doesn't have stays in `restsOn` as written, since
     nothing can say whether the learner holds it and checks are placed only on the lesson's own
     terms. The plan may build on a taught term, so the lesson must be able to.
   - **What doesn't fit** is a step introducing a term that isn't planned (the feedback names the
     planned terms it most likely meant), or resting on a planned term no step up to it introduces.
     Such an outline is asked for again with the problems fed back, twice. The log carries each
     rejection's problem codes (`outline/not-planned`, `outline/not-held`) and steps; the messages
     quote terms, so only with `LOG_CONTENT`. After the third, the lesson fails with a message
     saying so, and the learner writes it again from the start (§4.2).
2. **Write** in one streamed call, rendered block by block — the learner reads step 1 while later
   steps are still being written (only unlocked steps are visible anyway).
3. **Validate per step**, a check exactly where one was placed included; regenerate only a failing
   step.

Lessons are expected at roughly 15–25 KB of markdown (the 50–90 KB of today's lessons was mostly
HTML/SVG). To be measured, then adjusted.

### 7.3 Inline checks and the gate

- **Checks at the point of need.** A check catches a missing piece before anything is built on it,
  so it goes where that would happen: before a step that rests on terms this lesson taught and no
  check has covered, the step before it ends with a check on those terms, however far back they were
  taught. The last step always ends with one, on everything still unchecked, since the homework rests
  on the whole lesson. Every other step has none and opens with the step before it (state
  `unchecked`), so the learner reads straight through to the next check. A check covering several
  steps is graded with all their sources in its prompt. Placement is computed by the app, not chosen
  by the model, so it is predictable and testable; its weak point is the outline's `restsOn`, since an
  idea a step leans on without naming it as a term gets no check before it (the eval measures this,
  §11). Lessons written before this (every step checked) were migrated as one check per step, gating
  where the next step rested on it.
- Each check is one or two lines. The strong model grades it inline.
- **Landed** → the steps after it unlock, and the page scrolls to the first once the verdict has been
  read.
- **Miss or "I don't know"** → a repair thread opens under the check (the one place explanation
  happens outside the lesson), then a **fresh** question on the same idea — never the same one again.
  A marked "After the check-back" note is added under the check; later steps are not rewritten.
- **Still shaky after a repair:** if a later step **rests on** the check (every check but the last), offer
  **Pause here** (next time opens with a fresh question on this idea — the incubation option) or
  **Continue anyway** (step flagged "settling", its terms stay `taught`, homework and the next session
  re-test it). After the last check, continue freely with the step flagged.
- **"I already knew this."** The grader records what the learner showed they held before the lesson
  taught it (`lessons.already_held`, by step; logged, so it can be counted: the lesson was pitched
  below them there). The later checks of the lesson hear it and don't re-explain it; the reply never
  promises to change the rest of the lesson, which is already written. The calls after the lesson
  (homework, the recap, the term sweep, "where you left off") get the whole check record: each answered
  check, what it covered, its thread, where it leaked and what was already held. So the next session's
  plan starts above it, through the plan's notes and "where you left off".
- **The term sweep settles statuses from the evidence itself** (decided 2026-09-29, #17), as the
  method asks ("from the whole session's evidence"), not from the recap's summary of it: it gets the
  session's conversation as the recap did (a long session's older turns as their running summary,
  which quotes the learner's words where they are evidence, §4.4), then the recap, and the check
  record in its system prompt. It costs about as much input as the recap (§4.4, the budgets); its
  `duration_ms` per attempt is recorded like every call's.
- Why checks at the point of need: a step nothing rests on yet doesn't need to be solid before the next
  one, and a check there only interrupts reading; asking a few steps after an idea was taught is also
  better practice for remembering it than asking straight away (spaced retrieval).
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
  the next visit); email in v2 (#30). "Rework" is hidden until v2. How it is built below.
- **Arc exams** follow the method (transfer problems, cross-session questions, one build, re-tested
  misconceptions — never recall). Never taken halfway; "Later" allowed. Starting the next arc with an
  exam open gives one warning, and its re-tests fold into the next session's probe.
- **The final** is a session kind with no homework: a fresh audit (new fix-list compared with the
  original) and a teach-back where the model plays a skeptical friend asking only "why?" and "what if?".

How homework is built (#38, decided 2026-09-29; `packages/core/src/assignment.ts`,
`apps/api/src/engine/assignments.ts`, `apps/api/src/routes/assignments.ts`, `apps/web/src/homework`,
`apps/web/src/editor`):

- **Written, then recorded** (prose first, §7.1). The `homework` job writes the task as a chat
  message the learner watches, told its kinds and its answer boxes (so it writes no blanks) and its
  blocks (§6.3). A structured call on the finished message then records a few words naming it, the
  kind of each task and "what a good answer demonstrates" (two to six items, checked against the term
  list like anything the learner reads; a broken record is asked for once more, then kept). Both are
  kept once written, so a job tried again goes on from where it stopped.
- **An assignment is its own row**, outliving its session: the session that assigned it, a kind
  (`homework`; `exam` for #42), a name, its **tasks** and the checklist. Homework is one task, the
  whole message; an exam will be one task per `##` part, each with its title (`tasksOf`), so the
  answers, the checks on them and the review are the same code for both. A task's kind is one of
  `predict`, `derivation`, `build`, `explain`, and its answer fields come from the kind
  (`TASK_FORM_SPECS`): the prediction, what actually happened, reconcile; steps each with a
  "because…" (as many as the learner adds, up to 30); what you made and what surprised you; one
  explanation. A build's brief is the task itself.
- **Answers are markdown**, one string per field, in `submissions`, saved as the learner writes
  (800 ms after the last keystroke, and at once before a lock or handing in). The prediction **locks**
  with the server's time (`POST …/tasks/:taskId/lock`); from then on it can't change, and until then
  what happened and reconciling can't be written. **Handing in** takes every field written and the
  prediction locked (never half-done, as the method says of exams), and freezes the answers.
- **Pictures** pasted, dropped or picked go to `POST /api/assignments/:id/files`: an image by its
  bytes (PNG, JPEG, WebP, GIF), at most 5 MB, 20 per assignment, stored under the track in the file
  store and linked from the markdown by `/api/assignments/:id/files/:fileId`. They are served to
  their owner only, inline, as the type their bytes say, with `nosniff` and a `default-src 'none'`
  policy; deleting the track deletes them with its files (§4.5). `parseAnswer` (`@grounded/content`)
  turns an answer into a block tree with these as `picture` blocks, which no model can write: what
  the review's comments (#39) anchor to.
- **The session waits for it.** The homework phase is `writing` until the assignment is kept, then
  `assigned`: the learner's turn, no job awaited. Handing it in (`homework-handed-in`) or **Later**
  (`homework-later`) moves the session to its close. Later keeps what was written and leaves the
  homework open, snoozed (below). An assignment handed in after its session closed changes no
  session.
- **Where it is done**: its own page, `/homework/:assignmentId`: what kind it is, its name and
  session, the task in the lesson's type, the answer boxes of its kind, and **"A good answer
  shows"**, the checklist, to tick off before handing in (the ticks are the learner's own, kept in the
  browser; the review marks the items). The checklist sits in the right margin on a wide screen,
  above the answers otherwise. **Hand it in** and, while the session waits, **Later**. The chat
  shows the homework's message with "Open the homework" and "Later" under it, then its state;
  the track list and the track page list it as an item (§9.2).
- **Later always says when** (#41, decided 2026-09-29; `packages/core/src/snooze.ts`): the button
  opens "Remind me: Tonight / Tomorrow", each with its time on the learner's clock, and
  `POST …/later` takes `{ snooze, timeZone }`, the browser's IANA time zone. There is no Later
  without a time: a snooze is what makes putting off different from skipping silently. The server
  works the time out (`snoozeUntil`) and keeps it as `assignments.snoozed_until`:
  - **The learner's day starts at 4 a.m.**, not midnight, so "tomorrow" said at 1 a.m. means after
    sleeping, and "tonight" at 1 a.m. is over.
  - **Tonight is 8 p.m.** of the learner's day, offered only while it is still ahead (after 8 p.m.
    the menu has only Tomorrow, and the server refuses a tonight that has passed). **Tomorrow is
    9 a.m.** of the next day. Both are wall-clock times in the learner's zone, so a change of clocks
    doesn't move them.
  - Open homework can be put off again, from its page or the reminder, whether or not its session
    still waits for it; that only moves the time.
  - **Due** is the snooze's time passed. The item's tag (§9.2) says when in the learner's days, from
    the browser's zone: "tonight" (or "today" for a time before 5 p.m.), "tomorrow", a date, and "due"
    once it is.
  - **The reminder on the next visit**: while homework is due, a card at the foot of every page but
    its own ("Homework due", its name, track and session; Open it, Later, and a close button that
    hides it for this visit, `sessionStorage`, until it is put off again). It is the only reminder on
    a phone, where the sidebar is hidden.
- **The next homework subsumes an open one** (method.md, "Homework"; #41, decided 2026-09-29). The
  homework call is given the track's homework still open (not handed in, not folded), each with its
  task as the learner read it, its checklist and what they have written so far, under "Homework the
  learner put off, still open", told to write one task that also covers their ground, rebuilt on
  this session's, and standing alone. Once the new homework is kept, every one of them is **folded
  into it**: `assignments.subsumed_by` names the new one, set in one update on rows still open, so
  one handed in meanwhile stays handed in. Folding is the app's, not the model's: the method says
  the next homework subsumes an open one, always, so there is nothing to choose, and a model's
  record naming what it folded could only be wrong. A folded homework is closed like one handed in
  (its answers, pictures, Later and handing in refused with "folded into a later one"), is done in
  the track list ("Homework · session 2 · folded into session 4"), no longer due, and its page shows
  its answers read-only with a link to the homework that took its place. Only homework is folded; an
  arc exam (#42) is never subsumed.
- **The editors** (Tiptap, `apps/web/src/editor`). The answer editor: markdown as it is typed
  (`##`, `-`, `**`, `` ` ``, ` ``` ` for a code block), `$…$` maths rendered once the closing
  dollar is typed (a dollar next to a space doesn't open or close one, so "$5 and $6" stays money)
  and `$$…$$` on a line of its own, a click on a formula turning it back into text; pictures. It
  reads and writes markdown (`@tiptap/markdown`). **The one-line version** for check answers and
  questions in the margin (`Composer` with `rich`): one paragraph, Shift+Enter breaks the line,
  `code`, bold, italics and `$…$`; Enter sends what the editor holds at that moment. What the learner
  wrote there is shown with its code and maths (`LearnerText`). The chat and a new track keep the
  plain box.

### 7.5 Asides

- Select any passage in a lesson → ask. The card appears in the margin beside it, streamed at once.
- Context: the passage and its step, the whole lesson, the track's term list, earlier asides on the
  lesson. Model: the cheaper one. Obeys the term list; may use text, math, code, diagram, stepper.
- A few sentences by default, with follow-ups in the card. A question about something the lesson
  teaches later gets **a small taste plus the promise that it comes later**, never a spoiler.
  A tangent can be **saved for a future session** (added to the plan as a candidate).
- Anchoring: block id + the quoted passage with a little text before and after it, so a card survives
  a repair note being added nearby. Cards feed the check-back and the next session.

How it is built (#37, decided 2026-09-29):

- **Asking** (`apps/api/src/routes/asides.ts`): `POST /api/sessions/:id/asides` with the anchor
  (`blockId`, `quote`, and up to 64 characters of `prefix` and `suffix`, `AsideAnchor` in
  `@grounded/core`) and the question; follow-ups go to `…/asides/:asideId/messages`. Only a step the
  learner can read takes questions (every check before it landed or was continued past), and only
  while the session is open: asides feed its checks and its close, and a closed session has none to
  feed. One question at a time per card: a follow-up waits for the answer.
- **The answer** is a job (`aside`, `apps/api/src/engine/aside-tasks.ts`): the cheap model, purpose
  `aside`, streamed into the card (`aside-delta` events, replying to the question's id) and then
  validated like a chat message (`composeReply` in `chat.ts`), against the aside allowlist and the
  term list, where the terms the lesson introduced up to the learner's step count as taught; a
  broken answer is rewritten once. It shows no activity in the session's status line: the card says
  it is thinking. Its prompt is the aside phase's method and the track, then (stable first, so asides
  on a lesson share a cached start) the whole lesson with each step marked readable, locked ("don't
  spoil it") or not written yet, the earlier asides on the lesson, and the passage in its step with
  the blocks the answer may use; the card's thread is the conversation. A failed answer says so in
  the card ("That didn't go through… Ask again"), and the session goes on.
- **The record** follows the answer, so the answer never waits for it: a structured call (purpose
  `aside-record`, cheap model, little reasoning) returns evidence on the track's terms and a tangent,
  if the answer offered one. Evidence goes straight into `term_events` in the aside's own job (not at
  the close's sweep), source `aside`, one row per term with its status unchanged (`from_status` =
  `to_status`): the method has an aside change no status, and the checks, the sweep and the next
  session weigh the evidence. Terms not on the list are left out. If the record fails, the aside has
  none.
- **Saving a tangent**: the card offers "Save for a future session" when the record named one; saving
  adds it to the plan's notes (`add-plan-notes`, with the learner's question), which the close folds
  into the plan and "where you left off", so a later session's plan hears it. Once per aside.
- **Where asides go**: the check on the steps they were asked on, and the homework, the recap, the
  term sweep and "where you left off" (so the next session), under "Questions the learner asked in
  the margin of the lesson", each with its step, quote and thread.
- **Recovery**: an aside still waiting when its job died is told so in its card (§4.2).

## 8. Learner profile and stats

- **Teaching notes** about how this person learns ("abstract ideas land after a concrete example
  first"; "prefers predict-then-verify"). Every note is phrased as teaching guidance, never a judgment
  of ability; cites its evidence (sessions, checks, asides); is revised or removed at each refresh, not
  appended. Built on evidence: the first after ~6 sessions (across tracks), a note needs a pattern in
  ≥3 sessions, refreshed ~every 5 sessions, at a session close (the learner is present). Always in
  context, kept to about a dozen notes. Visible and editable by the learner. No vocabulary in it.
  How it is built (#44, decided 2026-09-29; `apps/api/src/engine/profile.ts`):
  - **When**: after the recap, the close queues the `profile` job if a refresh is due: 6 closed
    sessions across tracks and no refresh yet, or 5 closed since the last. Every refresh is recorded
    (`profile_refreshes`), changed or not, so "since the last" is exact; a failed one (key,
    provider) records nothing and the next close tries again.
  - **Evidence**: each session closed since the last refresh (all of them for the first), labelled
    S1, S2…: its check record (checks, repairs, where it leaked, what was already held), its
    asides, and its chat from the homework on (the homework, the learner's replies, the recap).
    Homework reviews and the forms chosen (#38, #39) join here as they are built.
  - **The call**: strong model, the `profile` phase's method; the current notes labelled N1, N2…
    with what they rested on, marked when the learner wrote or edited them. It returns every note
    as it should now stand (`teachingNotesSchema`): a note keeping one of the current ones revises
    it and adds its new evidence to the old; one left out is removed; a new one must cite at least
    three sessions of the evidence, or it is dropped; past 12, new ones are dropped. So notes are
    revised or removed, never merely appended.
  - **Race-safe**: the write holds a per-learner advisory lock, and is dropped if another refresh
    finished meanwhile (two tracks closing at once); a note the learner edited while the call ran
    is left as they left it.
  - **In every call**: `loadTrackContext` carries the notes (`teachingNotes`), so every session
    call has them, in the track's part of the prompt.
  - **The learner's page**: "How you learn" (`/teaching-notes`, from the account menu): each note
    with the sessions it rests on ("Seen in 3 sessions", each a link); the learner edits, removes
    and adds notes (at most 12). A note they write or edit is marked theirs until a refresh
    revises it; a refresh keeps its sense unless the evidence clearly disagrees.
- **Stats per track (v1):** ideas you own, ideas still settling (each clickable, in plain words),
  sessions done, open homework and exams, and the track's map. Learner-facing text never uses the
  method's scaffolding words — "ideas you own / still settling / to revisit", not
  "confirmed / taught / assumed".
- **The track page** (built 2026-09-29, #45; `GET /api/tracks/:id/progress`,
  `apps/api/src/track-progress.ts`, `apps/web/src/components/track-progress.tsx`):
  - **Open now**: the track's items not done, each a row as the track list says it (§9.2) that
    goes on with it; it stands in for a "continue" button. It reads the track list's items, not the
    progress endpoint, so homework and arc exams (#38, #42) show here as they join the list as kinds.
    "Start a session" shows while no session is open.
  - Three figures: ideas you own, still settling, sessions done (the done items that are sessions).
  - **Still settling** (taught) first, since that is what the next sessions come back to, then
    **ideas you own** (confirmed, assumed and borrowed; assumed marked "you brought it", borrowed
    "from <track>"). Each idea is a button: it opens where it stands in plain words (how it came
    to be owned or that it isn't solid yet), the learner's words its latest change recorded, the
    session it happened in (a link; found by time, as a track's sessions never overlap) and what it
    rests on. Ideas still to come are counted, never named: they haven't been taught.
  - **To revisit**: the open fix-list items, as the tutor wrote them.
  - **The map**, one arc at a time (tabs, the arc the track has reached first, marked "now"), with
    its counts; the arc's picture (§9.1) draws the arc's ideas and what they rest on, and an owned or
    settling idea in it opens the same details.

## 9. UI

Visual direction: thin, minimal, modern — the look of today's AI tools, not their chat-only UX.
Built with **shadcn/ui** (Tailwind + Radix), themed with our own tokens.

### 9.1 Lesson page — prototype verdict

Prototype: `prototypes/lesson-page-prototype/index.html`, since removed (it is in the git history).
Three structurally different variants were explored
(docs margin, focus reader, paged steps) and combined into:

- **Left: the track list**, collapsible (☰) for distraction-free reading.
- **Top: a Chat / Lesson switch.** Chat holds the session's conversation (probe, plan with its picture
  and approval). Lesson is the reading view.
- **The pictures of what rests on what** (decided 2026-09-29, #47; `apps/api/src/term-map.ts`,
  `GET /api/sessions/:id/pictures`, drawn by `TermMapPicture` in `apps/web/src/components/term-map.tsx`).
  All of them are drawn by the app from `term_dependencies`, never by the model, the same way: a
  picture is drawn around some ideas (its focus) and shows them with what they rest on directly, one
  level down, and only the focus's own lines. Each idea sits above what it rests on, so the ground
  is the bottom row (layered by the longest chain under each idea, each row ordered to keep lines
  short: `layers` in `apps/web/src/lib/term-map.ts`, deterministic). The focus is in full colour and
  the ground paler; owned ideas are filled, those still settling outlined and those to come dashed,
  with a key in the learner's words. Pointing at an idea follows its lines. A whole arc or the
  track's whole map is too many ideas to read in one picture, so none shows more than its focus
  and one level under it:
  - **The plan** draws the ideas its record planned (`session_messages.plan_terms`, written when the
    record applies), inside the latest plan's card under "What rests on what", once recorded. The
    plan message names them already; the picture adds what rests on what.
  - **The lesson's end**, after the last check (the session in homework or later), draws "What you
    just built": the ideas the outline introduces. Never before: the lesson has no opener (§3.2).
  - **The track page** draws one arc at a time (§8).
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

As built (#37, `apps/web/src/lesson/aside-*.tsx`, `passages.ts`):

- **Selecting and asking.** A selection inside one step's lesson text (the blocks with the step's ids;
  not a check's thread, a note or the page's labels) shows an "Ask about this" button in the margin,
  level with it; it opens a draft card there with the question box focused. Enter asks; Esc or
  Cancel drops it. The card that arrives takes the draft's place, open.
- **Marks without markup.** Passages are marked with the CSS Custom Highlight API (`::highlight`),
  so the lesson's elements are never touched: a faint wash and underline, stronger for the open
  card's passage. A card finds its passage again from the anchor on every layout: its block first,
  then its whole step, the occurrence whose text around it matches best; a passage that is gone
  leaves its card at its step's top, quoting it. Clicking a marked passage opens its card.
- **Cards.** Level with their passages, never overlapping; the open card sits exactly by its passage
  and the others move out of its way (`placeCards`). A closed card shows the first question and the
  start of its answer; the open one the whole thread, a tangent to save, and a follow-up box. The
  answer is revealed as it streams, like a chat message; "Thinking…" until its first words. Cards
  are re-measured whenever the page reflows or a card grows.
- **The hint is per learner:** it shows until they have asked in any session
  (`hasAskedAside` in the session's snapshot), not in every lesson.
- A closed session's lesson shows its asides but takes no new ones (§7.5).

### 9.2 Track list

A "typographic index" of parents and children (redesigned 2026-09-29, #57: the first version drew a
track and its sessions as equal rows between full-width rules, so the list read as one flat column,
and marked the current track with bolder text):

- At the very top, the **Grounded** wordmark (Notable, accent colour) in a row as tall as the Chat /
  Lesson bar, so the sidebar and the main view share one header band. It links home.
- Below it, a clearly visible **+ New track** button (accent, dashed border), then search (`/`).
- **A track is a parent line:** a chevron and the serif name (every track at the same size and
  weight). No rules between tracks, only a little space. The chevron opens and closes its items; the
  name opens the track's page.
- **Its items hang below it from a thread line** (a hairline from under the chevron, down the items'
  left edge), indented to the name, in sans: session, homework, arc exam, oldest first. So the parent
  and its children differ in typeface, size, indent and the thread, never in weight.
- **An item row says what the item is about**, over a small-caps line saying what it is: a session
  shows its lesson's title ("Why two writers lose an update", up to two lines; the outline names
  it, §7.2) over "Session 4 · lesson"; a lesson outlined before titles shows the terms it
  introduces instead ("Working copy, lost update, race condition"). Before its lesson is outlined,
  what is under way stands in ("Finding where you start", "Choosing what comes next") over
  "Session 4". Search finds a lesson by its terms too. Due items get a tag ("tonight").
- **The current track** (the page shows it or something in it) is open, its name in the foreground
  colour and its chevron in the accent; other names are muted. **The current item** is where the
  thread turns into the accent colour beside it, its text in the foreground colour.
- **Other tracks** start closed, one line each with what is waiting ("1 open", or "1 due" in the
  accent while homework is due, §7.4); the
  chevron opens them in place. Finished items fold into one line ("3 done ›") above the rest; the
  item on the page is never folded away.
- **A track's menu** (`⋯`, at the end of its line while the line is hovered or focused, in place of
  what is waiting) holds **Delete track…**, which asks first in a dialog naming what goes with it
  (sessions and lessons, what the learner has shown they know, the files they brought) and that it
  can't be undone ("Keep it" / "Delete track"). Deleting the track on the page goes home, which opens
  the next track (§4.5 for what is deleted).
- **Ordered by recent activity** (always): the latest change to the track or to anything in it
  (`activeAt` in `GET /api/tracks`, from `apps/api/src/track-list.ts`). **At scale (15+):** the six
  most recently active shown, plus the page's track wherever it falls, the rest under "N more
  tracks" (which turns into "Fewer tracks").
- **Search** (`/` from anywhere but a text box; built 2026-09-29, #55) filters tracks and lessons
  live, over all tracks: every word must appear, in any order, ignoring case and accents ("misir"
  finds "Mısır"). A track whose name holds them is shown as usual; otherwise a track shows open with
  only its items that hold them (finished ones included, unfolded), its name counting towards each
  ("sql joins"). Enter opens the first find, Escape clears. It runs in the browser on the list it
  already has.
- **Items are one shape, whatever their kind** (`kind`, `id`, `done`, `activeAt`, plus what the
  kind's row says), so ordering, folding, counting and search don't depend on the kind. Sessions
  and homework are built (#38): a homework item follows the session that assigned it, says its name
  over "Homework · session 4" ("· handed in" once it is), is done once handed in, and is active when
  it or its answers last changed; its row opens its page. Arc exams (#42) join the same way ("Arc
  exam · Arc 2"). Homework put off adds a `due` (snoozed until, for the "tonight" / "tomorrow"
  tag, §7.4) and homework folded into a later one a `foldedInto` (that one's session); a due item
  counts as "1 due" on a closed track and sorts the track by its due time once it has come
  too.
- **Account** at the bottom, in the sidebar: an initial and the email; it opens a menu upward (API
  key, theme, sign out).

### 9.3 Look

- Dark by default, light mode, "follow system" (decided 2026-09-29, #50): three icons in the
  account menu, the menu staying open so the change is seen. The choice is remembered per browser
  (`localStorage`, `apps/web/src/lib/theme.ts`), not per learner, so the sign-in page already wears
  it and nothing waits on the API; `index.html` applies it before the first paint. "Follow system"
  tracks `prefers-color-scheme` live, and a choice made in another tab is taken up. Diagrams,
  charts and highlighted code are drawn in the page's theme and redrawn when it changes.
- Serif for lesson text (Source Serif 4 in the prototype), clean sans for the app (Montserrat), Notable for the
  wordmark only.
- The brand is lucide's `layer-arrow-up` mark beside the Notable wordmark, both in the accent colour
  (the `Brand` component). The same mark, in each theme's accent, is the favicon.
- One accent colour, shared by diagram highlights, checks, cards and due tags.
- Sharp, not soft: corners stay tight (a 6px base radius; small controls 2–4px). Circles stay only
  for dots and icon buttons.
- Colour tokens defined once; Mermaid's theme generated from them. Diagrams use Mermaid's classic
  look: flat nodes, no drop shadows.
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
- The same labels carry a small working mark on their left: a Lottie animation of layers stacking up
  (`apps/web/src/assets/layers.json`), outlined in the label's colour over the surface behind it, so
  it holds in both themes. It holds still under reduced motion, and goes away with the label.

### 9.4 Phones (requirements; not prototyped)

- Sidebar becomes a drawer.
- The gutter timeline disappears; a compact "step 2 of 5" jump menu goes in the top bar.
- Margin cards become highlights you tap, opening a bottom sheet. Built with asides (#37), below
  1100px, where the margin is gone: a selection shows an "Ask about this passage" button at the
  bottom of the screen, which opens the sheet with the passage quoted and the question box; tapping
  a marked passage opens its card as the sheet; a tap outside closes it (and drops an unsent
  question). The hint is one line above the lesson. Left for the phone pass (#49): the sheet under
  the on-screen keyboard (iOS `visualViewport`), dragging the sheet down to close, the button's place
  against the phone's own selection menu, a way to see how many questions a step has without
  tapping each passage, and trying all of it on real phones.
- The check card stacks vertically below ~600px, with full-width touch targets (the prototype's check
  card is not responsive — fix in the real component).
- Building homework is a desktop activity; reading, checks and asides must be good on a phone.

### 9.5 A new track (decided 2026-09-28)

- **One box: "What do you want to learn?"** A composer that starts five lines tall and grows, for as
  many words as the learner likes (up to 4,000 characters): where they want to get to, where they
  start from, what it is for. Enter starts a new line; ⌘/Ctrl+Enter creates the track. The words are
  kept as typed (`tracks.goal`) and open every session of the track (§7.1).
- **The tutor names the track.** Words that already are a name (one line, at most 60 characters) are
  the name. Anything longer gets a stand-in at once, the first line cut at a word, and a job
  (`name-track`, the cheap model, purpose `track-name`) asks for a short name in the learner's
  language ("Backend interviews", not "I want to pass backend interviews"). The track list checks
  again every second while a track is being named (`naming` in `GET /api/tracks`). If the call fails,
  the stand-in stays. Naming is a job, not part of the request (§4.2), so creating a track never waits
  on a model.
- **Files come with the words** (§4.5): a paperclip button, files dropped on the box, or a picture
  pasted into it (text pastes as text). Each file shows as a chip with its name and size (a thumbnail
  for images) and a remove button; a file that can't go says why in place of its size, and holds
  creating back. The track page lists them under "What you brought", each a download.

## 10. Operating without an admin page

- Allowlist: `pnpm invite a@b.com`, `pnpm revoke a@b.com`.
- Model list: `packages/providers/src/models.ts` in the repo, reviewed with its eval results.
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

A test suite for AI models and for the method, not personalization. `pnpm eval` runs whole sessions of
the real app — the API and the worker in one process (`apps/api/src/embedded.ts`, which the test
harness shares), on a fresh database per run — with a fixed strong model playing a learner from a
persona sheet (`tools/eval/src/personas/*.md`: who they are, what they know, don't know and believe
wrongly, how they behave; cold start, warm start, a misconception, and a real learner's session). The
learner signs in and stores a key through the real routes, so every tutor call goes through the
production prompts, validators, retries and usage records; it answers the probe, reacts to the plan
(one revision at most), reads each step as it opens and answers the checks, until the session closes.

Each run is scored twice:

- **Counted** from the database: probe questions and stacked questions, steps and checks, checks
  landed on the first try, misses, steps left settling, what the learner already held, rewrites of
  drafts that broke a rule, errors shown, calls, tokens and cost.
- **Judged** by a fixed model against a fixed rubric (`judge.ts`), with the persona sheet as the
  truth about the learner, so it can say whether the probe found the level: the probe teaching or
  stacking questions, whether it located each strand and asked about the goal, whether its summary
  matches the learner, whether the plan fits their level and the first session reaches the goal,
  whether each check makes the learner use the idea or can be answered from the text, whether
  verdicts are right, misconceptions dislodged, promises kept, "I already knew this" heard, and
  factual errors. The rubric is its own text, not `method.md`, so one judge compares two methods.

`--model` picks the tutor (a model on the list; a new one joins as `pending` first) and `--method` a
version of the method, so a failure can be put down to the model or to the method by running the
other combinations: if it follows the method across models, it is the method's. Transcripts and
reports go to `tools/eval/results/` (not committed). Runs before a model joins the list and whenever
`method.md` changes; recording results next to each model-list entry, and turning a run into its
`gate: "passed"`, is still owed (#48).

## 12. Security and privacy

- HTTPS; least-privilege database roles; backups.
- Keys: §4.3. Content: never in logs (§4.2) or error reports; no content-reading UI. Attached files
  are content too (§4.5): only their owner can download them, and never inline.
- A plain sentence at sign-up (the sign-in page, since an invited email signs up by signing in):
  what is stored (answers, progress, questions, attached files, the encrypted key), that nothing is
  shared (the tutor's calls go to the provider whose key the learner brings), and that the operator
  can technically access the database but does not read it.
- Model output is never rendered as HTML or run as code; every URL is verified before display.

## 13. Settled since the grilling

- Product name: **Grounded**.
- Omer's manual ChatGPT test of `test/method.md`: passed.
- Omer's quality test of the Anthropic models (Opus 5.5, Sonnet 5.5, Haiku 4.5): passed (2026-09-28);
  they are offered in production.
- The method changes in §3.2: approved.
- Cost: Omer's measurement puts it at minimal with GPT-6 Luna; acceptable to proceed. Per-model cost is
  still recorded (§4.4) and reviewed as the model list grows.

## 14. Order of work

Steps 1–6 are built, with the gaps listed after them; 7–10 are not built yet. Every piece of v1
still owed has an issue labelled `high priority`, listed with its step; the issues are what track
progress, so a step is done when its issues are closed.

1. `method.md` at the repo root: the tested chat-app version adapted to the app (phase tags, the §3.2
   changes, what the app provides in context and what the model returns).
2. Repo setup: git, pnpm workspaces, lint/format/test tooling, CI, Docker, Postgres locally.
3. `packages/content`: block-tree types, parser, allowlists, validators (with tests); renderer
   components in `apps/web` (shadcn + our tokens), starting from the prototype's verdict; the
   cheap model's review (#52).
4. Auth (allowlist + magic link), key entry with envelope encryption, provider adapters, usage logging.
5. One track, one session end to end: phases, probe/plan chat, lesson generation pipeline, inline
   checks with repair and the gate, close with structured state edits. Owed: the opening review (#40).
6. Asides in the margin (#37). Owed: their polish on phones, with the phone pass (#49).
7. Homework (typed kinds, Tiptap, images, review on submit, Later/snooze), arc exams, the final
   (#38, #39, #41, #42, #43).
8. Learner profile (teaching notes, #44), per-track stats (#45), the usage display (#46).
9. Eval harness (built, §11); fill the model list with its results (#48).
10. Phone pass (#49); deploy; invite the first people. The track list's search (#55) and the sign-up
    sentence (#56) are built.
