---
name: create-issue
description: File a GitHub issue on this repo (OmerYesilkaya/grounded) from Omer's request. Use whenever Omer asks to create, open or file an issue.
---

# Create an issue

1. Read only what grounds the issue: the relevant section of `docs/design.md` (and `method.md` if it
   touches teaching). Don't explore further; the issue records the idea, not its implementation.
2. Write it in the repo's issue style:
   - **Title:** one plain sentence stating the behaviour, as a fact about the product
     ("A session's plan replaces the track's whole plan", "A lesson gives a new word its own card").
     No prefixes, no "Feature:", no trailing period.
   - **Body:** short paragraphs, product words, backticked identifiers. What happens today (with
     `docs/design.md` § or file refs), what Omer wants, and why — keep his example if he gave one.
   - Omer's decisions go in a bold line: `**Decision (Omer, YYYY-MM-DD):** …`.
   - What he explicitly set aside goes under `**Later (not in this issue):**`; open design questions
     under `**Open questions:**`. Don't invent decisions he didn't make.
   - No labels, no attribution lines.
3. File it (body via heredoc to keep formatting):

   ```sh
   gh issue create --title "<title>" --body-file - <<'BODY'
   <body>
   BODY
   ```

4. Reply with the issue number and link, plus anything you interpreted (e.g. a corrected word).
