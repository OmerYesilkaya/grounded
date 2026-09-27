# Testing method.md in a chat app

`method.md` is the teaching method with everything Omer- and Claude Code-specific removed,
adapted for a plain chat app (ChatGPT, Gemini, Claude.ai). Progress travels by copy-paste.

## Running a session

1. Start a new conversation. Paste the whole of `method.md` as the first message, followed by:
   "Follow this method exactly. I want to learn <subject>." It is about 36 KB; if the app refuses
   a message that long, attach the file instead and say "read the whole attached file before
   replying and follow it exactly".
2. Continuing a subject: paste `method.md`, then the progress file from the last session, then any
   homework answers.
3. At the end, save the progress file the model gives you (one file per subject).

A ChatGPT Project's instructions field is too short for the whole method, and uploaded project
files may only be partly read, so pasting it every time is the most reliable way.

## What to watch for

These are the rules weaker models break first, and the ones the app's quality gate will check:

- **The probe teaches.** Any "that's right", correction, hint or explanation while it is asking
  about your level.
- **Teaching in chat.** Explanations outside the lesson message (except repairs after a missed
  check).
- **Untaught terms.** A domain word used in chat, the lesson or homework before it was explained
  and named.
- **Scaffolding words in what you read.** root, node, edge, graph, map, frontier, ledger,
  confirmed, taught, assumed, "Phase 2", or ideas referred to by number.
- **Stacked questions.** More than one question at a time, or checks that need a paragraph.
- **Pointers instead of restating.** "the example from earlier", "as we saw" without the fact.
- **Time talk.** "yesterday", "this should take 20 minutes".
- **Progress file quality.** Does the next session actually pick up where the last one ended?

Also note what felt good or bad as a learner: the probe → plan → lesson → checks rhythm, the
lesson's length, the drawings.
