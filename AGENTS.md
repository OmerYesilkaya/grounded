# Grounded — agent instructions

- `docs/design.md` is the source of truth for product and architecture decisions. Read the relevant
  section before building a feature; when a decision changes, update the doc in the same commit.
- `method.md` is the teaching method and the system prompt. Changes to it change how every learner is
  taught; propose them to Omer before committing.

## Commits

- Commit directly to `main`; no feature branches needed in this repo.
- Commit often, one concept per commit: a commit holds everything that belongs to one idea (the code, its
  tests, the doc update) and nothing unrelated. Split only where the concepts differ.
