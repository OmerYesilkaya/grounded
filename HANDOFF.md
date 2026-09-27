# first-principles-tutor — handoff

A web app that gives Omer's friends and family the teaching method he built for himself in
Claude Code. They sign in, paste their own AI provider API key, and learn any subject the way
the method teaches: from unconditional truths upward, every step motivated, no word used
before it has been taught.

`first-principles-tutor` is a working title for the GitHub repo. The product name is still
open (Omer wants something Turkish written with plain ASCII letters; candidates so far: Kavra,
Temel, Zemin, Anla. None chosen).

Nothing is built yet. This document records what was decided and why, so the next session
can start building without re-deriving it.

## What already exists (the source)

Everything lives in Omer's personal learning repo, `~/Omer/Learning`. It is a Claude Code
project, not an app: the model runs inside Claude Code on his Mac and reads and writes files.

| Piece | Path in `~/Omer/Learning` | What it does |
| --- | --- | --- |
| The method | `.claude/skills/teach/SKILL.md` | The whole pedagogy: two principles, the terminology ledger, the session shape, homework, arc exams, the final. The core of everything. |
| Design summary | `README.md` | Design decisions and roadmap, in short form. |
| Researcher | `.claude/agents/researcher.md` | Subagent with web search, used to scope topics and fact-check before teaching. |
| Lesson page template | `tools/ask/lesson-template.html` | Dark, self-contained HTML skeleton each lesson is written from, including the drawing conventions. |
| Ask on the page | `tools/ask.mjs`, `tools/ask/widget.html`, `tools/ask/README.md` | Select a passage in a lesson, ask a question, get an answer in place from a headless `claude -p` run. Answers saved into the page and into `asides.md`. |
| Daily quiz | `tools/quiz.mjs`, `tools/quiz/core.mjs`, `tools/quiz/README.md`, `tools/quiz-handoff.md` | One open-ended question a day across all subjects, Leitner-spaced, graded on the page, never gives the answer. Results feed the next session. |
| Shared runner | `tools/lib/claude.mjs` | Spawns `claude -p` with read-only tools. |
| Personal data | `tracks/`, `quiz/` (gitignored) | Omer's subjects, progress files, lessons, homework, quiz log. **Never copied.** |

Read `SKILL.md` and `README.md` in full before designing anything; the app is a new home for
that method, not a new method.

### How a session works today

review → probe → plan → write the lesson page → learner reads → check → homework → close.

- The terminal (chat) only asks: probing questions, the plan, the checks, the recap.
- The teaching is a page (`lesson.html`) the learner reads in a browser.
- Every subject is a *track* with a `state.md` (the ledger of terms and their status, the
  dependency map, the plan, the session log), rewritten at the end of each session so the
  next one picks up where it left off.

## Decisions made

1. **A web app, not a prompt pack.** A version pasted into ChatGPT / Gemini / Claude chat
   apps was considered and rejected as the main product: those apps cannot reliably write
   progress back, so the learner would juggle a progress file by hand, and the quiz and
   ask-on-the-page features are impossible there. Most of the value is the loop around the
   conversation, which needs an app.
2. **Everyone brings their own API key.** Users sign in and enter a key; the app calls the
   model with it. Chosen over:
   - *Paid subscription to Omer:* would bring payment processing, tax/VAT, terms, refunds
     and support — the obligations of a business — for no gain; Omer does not want to make
     money.
   - *Omer pays for everyone (free, invite-only):* was the earlier recommendation; Omer chose
     BYOK instead.
   - *Sharing Omer's Claude Max subscription through the app:* rejected. Consumer
     subscriptions are for one person; Anthropic's terms do not allow letting others use the
     account, and its developer docs say apps for other people must use an API key. It would
     also risk his own account, and Max's rolling limits could not be split or capped per
     person.
3. **Audience: friends and family, invite-only.** Not a public product. No payments in the
   app at all. If it ever spreads beyond people Omer knows, revisit the legal side.
4. **Only the core is shared.** The method, the tools' behaviour and the templates.
   None of Omer's tracks, progress, quiz history, memory, or quotes.

## Open decisions

- **Providers at launch.** Deliberately left open. Options discussed:
  - *OpenRouter only* — one key reaches Claude, GPT and Gemini models; one adapter; one
    setup guide.
  - *Anthropic + Gemini direct* — Gemini's AI Studio has a free tier and the easiest key for
    non-technical people.
  - *Anthropic, OpenAI, Gemini direct* — most familiar brands, three adapters, three model
    families to test.
- **Which models are allowed.** BYOK means users may pick weaker models. The method's
  strictest rules (never use an untaught term; the probe teaches nothing) are what weak
  models break first. Proposal: support only models that pass a scripted evaluation (see
  "Model quality gate").
- **Product name** (see top).
- **Stack and hosting.** Not discussed yet. Constraint: small scale (a handful of users), a
  managed host with Postgres is plenty. The existing tools are Node (`.mjs`), which argues for
  a TypeScript stack.
- **Sign-in method** (email magic link, Google, invite codes).

## What BYOK means for the design

- **Onboarding is the hardest part for the audience.** A ChatGPT Plus or Gemini
  subscription does not include API access. Users need a developer account on the
  provider's platform, billing set up there, and a key. The app needs a step-by-step setup
  guide per supported provider, written for non-technical people, including setting a
  **monthly spending limit on the provider's side**.
- **Users pay per use, on top of any subscription they have.** Show the cost of every
  session and a running monthly total in the app, computed from the provider's token usage.
- **Keys are the app's most sensitive data.**
  - Encrypted at rest, with the encryption key held outside the database (envelope
    encryption / a KMS or host secret).
  - Decrypted only on the server at call time; never logged, never sent to the browser
    after entry, never included in error reports.
  - Users can replace or delete their key; deleting the account deletes the key.
  - Keeping the key only in the browser was considered: safer for Omer, but then the server
    cannot generate the daily quiz while the user is away. With the quiz in scope, the
    server holds the key.
- **Provider adapter layer.** One interface for: streamed text generation, structured
  output (quiz generation and grading need JSON), web search (replaces the researcher
  subagent), and token usage reporting (for cost display). Each provider implements it.
- **Errors surface plainly.** Invalid key, out of credit, rate limited, and provider refusal
  each get a clear message telling the user what to do.

## Model quality gate

Because the model is the user's choice, each supported model must be tested against the
method before it is offered. Build a small evaluation set of scripted learners (a cold
start, a warm start, a learner with a misconception, a learner who says "I don't know") and
check, per model:

- no untaught domain term appears in chat, lesson or homework;
- the probe never explains, confirms or hints;
- none of the banned scaffolding words appear in learner-facing text (list in `SKILL.md`,
  "The scaffolding stays out of his sight");
- lesson drawings render, and their labels fit their boxes;
- checks are answerable in one or two lines.

Models that fail are not offered, or are offered with a warning.

## Architecture sketch

The current system is agentic: `claude -p` runs with Read/Grep tools and reads files. The
web app does not need an agent. The server knows exactly which data each call needs and puts
it straight into the prompt, which is simpler and cheaper.

| Today (Claude Code) | In the app |
| --- | --- |
| `tracks/<track>/state.md`, rewritten at close | A track record in the database: ledger rows, map, plan, session log. Updated by small structured edits returned by the model, not a full rewrite. |
| Session in the terminal | A chat panel in the app. |
| `lesson.html` written to disk, opened in a browser | A lesson stored per session, rendered by the app beside the chat. Template styling and the ask widget are added by app code, not generated by the model. Model-authored HTML/SVG must be sanitized before rendering (no scripts, no event handlers). |
| `homework.md` / `homework-answers.md` | Homework shown in the app; the learner answers in a text box. Same for arc exams. |
| Ask on the page via `tools/ask.mjs` on localhost | An endpoint in the app, same rules (aside mode, ledger-gated, may draw). |
| Daily quiz via `launchd` at 10:00 | A server-side daily job per user, with a notification (email) linking to the day's question. Selection and spacing logic can port from `tools/quiz/core.mjs`. |
| `researcher` subagent | The provider's web search tool, called during planning and fact-checking. |
| `quiz/results.md` read by the next session | Quiz results stored per term; loaded into the next session's context. |

Per user: account, encrypted key, provider/model choice, tracks, sessions, quiz state,
usage and cost log. Users can export and delete all their data.

## Extracting the method (first task)

Create `method.md` in this repo: the method from `SKILL.md`, independent of Claude Code
and of Omer. It becomes the system prompt the app sends (and later, Omer's own skill could
read from it too, so the method is not maintained in two places).

Remove or generalize:

- **Omer's name and pronouns.** "Teach Omer…", and about 78 uses of he/him/his → "the
  learner" / they.
- **His quotes**, turned into general reasons rather than deleted, because they carry the
  *why*:
  - line ~126: "I don't want to learn through the terminal, I just want you to probe
    through the terminal." → why chat only asks and the page teaches.
  - line ~155: "at the end of the probing I felt like I already learned most of it…" → why
    the probe teaches nothing.
- **Claude Code specifics**: the `Agent` tool and `researcher` subagent, `claude -p`, `date
  +%F`, file paths under `tracks/`, "if a browser is available, open it", `node tools/...`
  commands, the terminal as the chat surface.
- **File-based state instructions** ("write `state.md`", "look for `homework-answers.md`,
  spelling may vary") → replaced by what the app provides in context and what the model
  must return.
- Omer-specific names in the tools' prompts (`tools/ask.mjs:128`, `:144`;
  `tools/quiz/core.mjs:273`, `:435`: "Omer is reading…", "over coffee") when porting them.

Keep verbatim in spirit: the two principles, the ledger and its rules, free-text only,
"every artifact stands alone", the scaffolding-words ban, the session shape, homework, arc
exams, the spoken final, the drawing rules, conduct (accuracy, no assumptions about time).

Note: `SKILL.md` had an uncommitted change in the Learning repo when this was written;
extract from the latest version.

## Cost (what users will pay, estimated)

Estimated from Omer's real files (skill ~41 KB, a mature progress file ~55 KB, lessons
50–90 KB) at Anthropic prices as of 2026-09 (per million tokens: Opus 5.5 $4 in / $20 out /
$0.20 cached read; Sonnet 5 $2 / $10; Haiku 4.5 $1 / $5). **Not measured yet.**

- One full session on Opus 5.5: roughly **$2–4**; on Sonnet 5 about half. Most of it is
  output (lesson, updates, chat, the model's thinking). Prompt caching of the method and
  progress file is essential: without it, input costs are about ten times higher.
- A question asked on a lesson page: about $0.05–0.20.
- The daily quiz: about $0.10–0.30 a day.
- A lighter user (4–8 sessions a month): roughly $10–30 a month on Opus 5.5, $5–15 on
  Sonnet 5.

Savings the app gets for free over today's setup: widget and template styling added by
code (not generated), structured progress updates instead of full rewrites, and a cheaper
model for routine jobs (quiz grading, small asides) with the strong model kept for lessons.

Before choosing default models, measure: replay one of Omer's real sessions through token
counting (free), or run one real session.

## Privacy and legal (lightweight, but not skipped)

No payments, so no business obligations. Still, the app stores what people write about what
they don't understand, and holds keys that can spend their money:

- a plain sentence at sign-up saying what is stored (answers, progress, questions, the
  encrypted key) and that nothing is shared;
- a delete-everything button;
- sensible security (HTTPS, encrypted keys, least-privilege database access, backups).

## Suggested order of work

1. Extract `method.md` (above) and have Omer review it.
2. Settle the open decisions: providers, stack, hosting, sign-in.
3. Measure real session cost on the candidate models.
4. Build the evaluation set and run the quality gate on candidate models.
5. Design doc for the app: data model, provider adapter interface, session flow, lesson
   rendering and sanitizing, key handling, quiz job.
6. Build: sign-in + key entry → one track, one session end to end → lesson page with ask →
   homework → quiz → cost display → export/delete.
7. Onboarding guides per provider, tested with one non-technical person.
