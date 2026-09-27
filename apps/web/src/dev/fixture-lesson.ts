/** A lesson written the way the model writes one (method.md, "Format"), for the dev preview. */
export const FIXTURE_LESSON =
  String.raw`## Adding one is three moves, not one

You told me earlier that _"the computer just adds one to the number"_. That's true, and it hides something. The number lives in memory, and the part of the machine that does arithmetic can't reach into memory and change a value where it sits.

So to add one, it has to do three separate things: copy the value out, change the copy, and put the copy back. Each of those is a move of its own, and nothing forces the three to happen back to back.

` +
  "```diagram" +
  String.raw`
caption: Adding one to a number in memory takes three separate moves.
highlight: C
---
flowchart TB
  M[("memory: 5")] -->|copy out| R["working copy: 5"]
  R -->|change| C["working copy: 6"]
  C -->|put back| M2[("memory: 6")]
` +
  "```" +
  String.raw`

Keep that gap in mind: between copying the value out and putting it back, the value in memory is still the old one.

:::check
In one sentence: what is in memory while the working copy is being changed?
:::

## Two workers, one number

Now give the same job to two workers at once. Each one does its own three moves. Remember, the three moves of one worker don't have to happen back to back, so the other worker's moves can land in between.

In code, both workers run exactly this:

` +
  "```js" +
  String.raw`
let copy = counter; // copy the value out
copy = copy + 1;    // change the copy
counter = copy;     // put the copy back
` +
  "```" +
  String.raw`

Step through what can happen when the number starts at 5 and both workers add one:

` +
  "```stepper" +
  String.raw`
caption: The number in memory is 5. Neither worker has started.
---
flowchart TB
  M[("memory: 5")]
  A["worker A: idle"]
  B["worker B: idle"]
--- frame
caption: Worker A copies the value out. Its working copy is 5.
---
flowchart TB
  M[("memory: 5")] -->|copies 5| A["worker A: 5"]
  B["worker B: idle"]
--- frame
caption: Before A puts anything back, worker B copies the value out too. It also sees 5.
---
flowchart TB
  M[("memory: 5")] -->|copies 5| B["worker B: 5"]
  A["worker A: 5"]
--- frame
caption: Worker A adds one and puts 6 back.
---
flowchart TB
  A["worker A: 6"] -->|puts back 6| M[("memory: 6")]
  B["worker B: 5"]
--- frame
caption: Worker B adds one to its own copy and puts 6 back. Two additions, and the number went up by one.
---
flowchart TB
  B["worker B: 6"] -->|puts back 6| M[("memory: 6")]
  A["worker A: done"]
` +
  "```" +
  String.raw`

Nothing went wrong inside either worker. The update was lost in the gap between them, and it happens only when their moves interleave this way — which is why it can hide for months and then appear once. If each of $n$ additions can interleave, the final value can be anywhere from $5 + 1$ to $5 + n$.

:::check
In one sentence: why did the number end at 6 instead of 7?
:::

## Making the three moves behave like one

If the trouble is that another worker's moves can land inside the gap, the fix has to close the gap: while one worker is between copying out and putting back, no one else may copy out.

:::check
In one sentence: what must be true of the gap for the lost update to become impossible?
:::
`;
