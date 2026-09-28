# Grounded — agent instructions

- `docs/design.md` is the source of truth for product and architecture decisions. Read the relevant
  section before building a feature; when a decision changes, update the doc in the same commit. The
  package map (what lives in each `apps/*` and `packages/*`) is §4.1.
- `method.md` is the teaching method and the system prompt. Changes to it change how every learner is
  taught; propose them to Omer before committing.
- `README.md` covers local setup, deploy (Railway) and secrets.
- `~/Omer/Learning` is Omer's live learning setup and the origin of the method: read from it, port what
  you need into this repo, and leave it exactly as it is (no edits, writes or commits there; never copy
  its personal data, `tracks/` and `quiz/`).

## Commits

- Commit directly to `main`; no feature branches needed in this repo.
- Commit often, one concept per commit: a commit holds everything that belongs to one idea (the code, its
  tests, the doc update) and nothing unrelated. Split only where the concepts differ.
- A change is done when `pnpm check` passes (format, lint, typecheck, test: the same gate CI runs). Pushes
  to `main` deploy.
