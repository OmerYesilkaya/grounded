import { eq, tracks } from "@grounded/db";
import type { Embedded } from "../embedded.js";
import type { ModelAccess } from "../engine/model-call.js";
import { scriptedModel, scriptedModels } from "../test/scripted-models.js";

/*
 * Development only: tracks stopped at the stages that are slow to reach by hand (homework, arc
 * exams, the final), so their pages can be looked at (`pnpm stages`, stages-cli.ts). Every track is
 * made the way a learner makes one, through the real routes and jobs, with canned model replies:
 * what a page shows is what the app would store, and a change to the app shows in the seed (its
 * test, stages.test.ts, keeps it working). The replies are about one made-up subject, why a shared
 * counter loses updates, taught in two sessions that close one arc.
 */

type Models = ReturnType<typeof scriptedModels>;

/**
 * The seed's canned replies: scripted per call as it goes, and a teaching-notes refresh (which a
 * close starts once enough sessions have closed) that changes nothing.
 */
export function stageModels(): Models {
  const models = scriptedModels();
  const access: ModelAccess = {
    ...models.access,
    model: (request) =>
      models.access
        .model(request)
        .catch((error: unknown) =>
          request.purpose === "profile"
            ? scriptedModel({ thenGenerate: [JSON.stringify({ notes: [] })] })
            : Promise.reject(error instanceof Error ? error : new Error(String(error))),
        ),
  };
  return { ...models, access };
}

/** The stages seeded, in the order the tracks are made (the track list shows the latest first). */
export const STAGES = [
  { key: "homework-open", title: "Stage 1 · Homework open" },
  { key: "homework-reviewed", title: "Stage 2 · Homework reviewed" },
  { key: "exam-open", title: "Stage 3 · Arc exam open" },
  { key: "exam-reviewed", title: "Stage 4 · Arc exam reviewed, final offered" },
  { key: "final-teach-back", title: "Stage 5 · Final, in the teach-back" },
  { key: "final-finished", title: "Stage 6 · Final finished" },
] as const;

export type StageKey = (typeof STAGES)[number]["key"];

export interface SeededStage {
  key: StageKey;
  title: string;
  trackId: string;
  /** Where to look: the page the stage is about. */
  path: string;
}

const GOAL = "Why does a counter shared by two threads sometimes end up too low?";
const ARC = "Two workers, one number";

// ---- The first session: the working copy ----

const S1_FIRST_QUESTION =
  "In your own words: what do you think happens, inside the machine, when a program adds one to a number?";
const S1_PROBE_ANSWER = "It just adds one to it, in one go.";
const S1_PROBE_SUMMARY =
  "Knows a program keeps values in memory; thinks adding one is a single step. Goal: see why a shared counter ends up too low.";
const S1_PLAN =
  "We start from what you already hold: a program keeps its numbers in memory. First we'll look closely at what adding one really takes, which is more than one move. Next time we'll put two workers on the same number at once and watch an addition disappear.\n\n- **Two workers, one number**: the working copy (this session), then the lost update.";
const S1_PLAN_RECORD = [
  { type: "add-fix-item", text: "Thinks adding one is a single step" },
  { type: "add-planned-term", term: "working copy", restsOn: [] },
  { type: "add-planned-term", term: "lost update", restsOn: ["working copy"] },
  { type: "add-to-arc", arc: ARC, terms: ["working copy", "lost update"] },
];
const S1_OUTLINE = {
  title: "Adding one is three moves",
  steps: [
    {
      heading: "Where the number lives",
      establishes: "the arithmetic part works on a copy",
      introduces: ["working copy"],
      restsOn: [],
    },
    {
      heading: "What memory holds meanwhile",
      establishes: "memory keeps the old value until the copy is put back",
      introduces: [],
      restsOn: ["working copy"],
    },
  ],
};
const S1_LESSON = `## Where the number lives

You said the computer "just adds one". It does, and that hides something: the number lives in memory, and the part of the machine that does arithmetic can't change a value where it sits.

So it takes a copy out, changes the copy, and puts it back.

:::word{term="working copy"}
The copy of a value that is taken out of memory to be changed, before it is put back.
:::

\`\`\`diagram
caption: Adding one takes three separate moves.
highlight: C
---
flowchart LR
  M[("memory: 5")] -->|copy out| R["working copy: 5"]
  R -->|add one| C["working copy: 6"]
  C -->|put back| M2[("memory: 6")]
\`\`\`

:::check
In one sentence: why does the machine need a working copy at all?
:::

## What memory holds meanwhile

Between the copy going out and coming back, memory still holds the old value. Nothing there has changed yet: the 6 exists only in the working copy.

That gap is short, but it is real, and next session it is where the trouble starts.

:::check
While the working copy holds 6, what does memory hold, and why?
:::`;

const S1_CHECK_2 = "Still 5, because the copy hasn't been put back yet.";
const S1_HOMEWORK = `Here is a program that adds one to a counter a thousand times:

\`\`\`python
counter = 0

for _ in range(1000):
    value = counter
    counter = value + 1

print(counter)
\`\`\`

**Predict** what it prints, and say which line takes the working copy and which puts it back. Then run it and compare.`;
const S1_HOMEWORK_RECORD = {
  title: "One worker, one counter",
  forms: ["predict"],
  checklist: [
    "Names the line that takes the working copy",
    "Names the line that puts it back",
    "Says what memory holds between those two lines",
  ],
};
const S1_ANSWER = {
  prediction:
    "It prints 1000. `value = counter` takes the working copy and `counter = value + 1` changes it and puts it back in one go.",
  observed: "It printed 1000, every time I ran it.",
  reconcile:
    "It matched. Each time round the loop the copy goes out and comes back before the next one starts, so nothing is lost.",
};
const S1_REVIEW = {
  comments: [
    {
      task: "t1",
      field: "prediction",
      quote: "changes it and puts it back in one go",
      items: ["c2"],
      comment:
        "You put two of the three moves on one line. Which part of `counter = value + 1` changes the copy, and which part puts it back?",
    },
    {
      task: "t1",
      field: "reconcile",
      quote: "",
      items: ["c3"],
      comment:
        "You said nothing is lost. What does `counter` hold at the moment `value + 1` has been worked out but not yet stored?",
    },
  ],
  checklist: [
    { item: "c1", mark: "held", note: "You name `value = counter` as taking the copy." },
    { item: "c2", mark: "leaked", note: "Look again at what the second line does, part by part." },
    { item: "c3", mark: "missing", note: "What is in memory between the two lines?" },
  ],
  actions: [],
};
const S1_RECAP =
  "We started from your picture of adding one as a single step, and took it apart: the machine copies the number out, changes the copy, and puts it back. While the copy is out, memory still holds the old value. Next time: two workers doing those three moves at once.";
const S1_LEFT_OFF =
  "Taught the working copy; the homework's review left one leak open on what memory holds between the moves. Next: the lost update, which closes the arc.";

// ---- The second session: the lost update, which closes the arc ----

const S2_REVIEW_OPENING =
  "Before we go on, your homework. You wrote that `counter = value + 1` changes the copy and puts it back in one go. Look at it once more: which part changes the copy, and which part puts it back?";
const S2_REVIEW_ANSWER =
  "`value + 1` changes the copy, then the `=` puts it back. Until then counter still has the old number.";
const S2_REVIEW_SUMMARY =
  "The working copy held: they now split the line into changing the copy and putting it back, and say memory keeps the old number meanwhile. Nothing to re-teach before the lost update.";
const S2_FIRST_QUESTION =
  "Thanks, that's the gap. Now suppose two workers run that same loop on the same counter at the same moment. What do you expect it to print?";
const S2_PROBE_ANSWER = "2000? Each one adds a thousand.";
const S2_PROBE_SUMMARY =
  "Holds the working copy and the gap it leaves. Expects two workers' additions to add up exactly. Goal unchanged.";
const S2_PLAN =
  "You hold the three moves and the gap between them. Today we put two workers in that gap at once and watch one addition vanish. That finishes the arc, so there's a short arc exam after the homework.";
const S2_PLAN_RECORD = [
  { type: "add-fix-item", text: "Expects two workers' additions to add up exactly" },
];
const S2_OUTLINE = {
  title: "Why two writers lose an update",
  steps: [
    {
      heading: "Two workers in the gap",
      establishes: "both copy the same value",
      introduces: ["lost update"],
      restsOn: ["working copy"],
    },
    {
      heading: "Why it hides",
      establishes: "it needs the moves to interleave",
      introduces: [],
      restsOn: ["lost update"],
    },
  ],
};
const S2_LESSON = `## Two workers in the gap

Two workers each add one to the same counter, which holds 5. Each does its own three moves, and nothing keeps one worker's moves together.

If both copy 5 out before either puts its copy back, both put back 6. Two additions happened; the counter went up by one.

:::word{term="lost update"}
An addition that vanishes because another worker put its working copy back over it.
:::

:::check
Both workers added one. Why does the counter show 6 and not 7?
:::

## Why it hides

It only happens when one worker's copy goes out inside the other's gap. Most of the time the moves don't overlap, so the program can run correctly for months and then lose an update once.

:::check
Why can a lost update go unnoticed for a long time?
:::`;
const S2_CHECK_1 = "They both copied 5, so both put back 6.";
const S2_HOMEWORK = `Run your loop from last time on two threads at once:

\`\`\`python
import threading

counter = 0

def work():
    global counter
    for _ in range(100_000):
        value = counter
        counter = value + 1

workers = [threading.Thread(target=work) for _ in range(2)]
for w in workers:
    w.start()
for w in workers:
    w.join()
print(counter)
\`\`\`

**Predict** what it prints. Then run it five times and compare.`;
const S2_HOMEWORK_RECORD = {
  title: "Two workers, one counter",
  forms: ["predict"],
  checklist: [
    "Predicts less than 200,000, and says why",
    "Shows the moment two copies go out together",
    "Explains why the result changes from run to run",
  ],
};
const S2_ANSWER = {
  prediction:
    "Less than 200,000. Sometimes both threads copy the same value before either puts it back, so one addition is lost.",
  observed: "131,822, then 200,000, then 157,013, 200,000 and 144,560.",
  reconcile:
    "Right that it's lower, but I didn't expect it to be exactly right twice. Those were runs where the threads happened not to overlap.",
};
const S2_REVIEW = {
  comments: [],
  checklist: [
    { item: "c1", mark: "held", note: "You say why it comes out lower." },
    { item: "c2", mark: "held", note: "Both threads copying the same value is the moment." },
    { item: "c3", mark: "held", note: "The two exact runs are the ones that didn't overlap." },
  ],
  actions: [
    {
      type: "set-term-status",
      term: "lost update",
      status: "confirmed",
      evidence: "both threads copy the same value before either puts it back",
    },
  ],
};
const EXAM = `This exam covers the whole arc, both sessions. Take it in one sitting if you can.

## A shared bank balance

Two cash machines pay out from one account holding 100. Each takes 30 at the same moment, doing the same three moves your counter did. **Predict** every balance the account could end with, then check your answer against the moves.

## The moves, one by one

Write out, move by move, how two workers can each add one to a counter holding 41 and leave it at 42. Give a reason for every move.

## A counter that can't lose

Change the two-thread program from your homework so it always prints 200,000. Paste what you made, and run it at least five times.

## For a friend

A friend says: "Computers do one thing at a time, so two threads can't really clash." Explain to them, in plain words, why they can.`;
const EXAM_RECORD = {
  title: "Lost updates beyond the counter",
  forms: ["predict", "derivation", "build", "explain"],
  checklist: [
    "Finds the lost payment in the bank balance",
    "Gives every move of the interleaving with its reason",
    "Keeps one worker's three moves together in the build",
    "Explains the clash without relying on two things happening at the same instant",
  ],
};
const EXAM_ANSWERS = {
  t1: {
    prediction:
      "40 if the machines take turns. 70 if both copy 100 out before either puts its copy back: one payment is lost.",
    observed:
      "Walking through the moves: both copy 100, both put back 70. So 70 is possible, and 40.",
    reconcile: "It matched; the bank loses 30 in the overlapping case.",
  },
  t2: {
    "step-1": "Worker A copies 41 out.",
    "because-1": "The arithmetic happens on a working copy, not in memory.",
    "step-2": "Worker B copies 41 out.",
    "because-2": "A hasn't put anything back yet, so memory still holds 41.",
    "step-3": "Both add one and put back 42.",
    "because-3": "Each changed its own copy of 41.",
  },
  t3: {
    work: "```python\nimport threading\n\ncounter = 0\nlock = threading.Lock()\n\ndef work():\n    global counter\n    for _ in range(100_000):\n        with lock:\n            value = counter\n            counter = value + 1\n```\n\n200,000 all five times.",
    surprised: "It got noticeably slower.",
  },
  t4: {
    text: "Even on one core the machine switches between threads, and it can switch in the middle of the three moves. So one thread can copy the number, get paused, and the other one copies the same number.",
  },
};
const EXAM_REVIEW = {
  comments: [
    {
      task: "t3",
      field: "surprised",
      quote: "It got noticeably slower.",
      items: ["c3"],
      comment:
        "You noticed the cost. While one thread is inside the `with lock:` block, what is the other one doing?",
    },
    {
      task: "t1",
      field: "prediction",
      quote: "40 if the machines take turns",
      items: ["c1"],
      comment:
        "Is 40 the only ending when they take turns? Try it with one machine finishing all three moves before the other starts.",
    },
  ],
  checklist: [
    { item: "c1", mark: "held", note: "You find the lost payment of 30." },
    { item: "c2", mark: "held", note: "Every move with its reason." },
    { item: "c3", mark: "leaked", note: "The build works; say what the waiting costs." },
    { item: "c4", mark: "held", note: "Switching between threads, not the same instant." },
  ],
  actions: [],
};
const S2_RECAP =
  "We put two workers in the gap you found last time: both copy the same value, both put back the same result, and one addition is lost. It hides because it needs the moves to overlap. That closes the arc; the arc exam takes it into new settings.";
const S2_LEFT_OFF =
  "The arc is closed; its exam is set. The plan is taught through: the final is next once the exam is in.";

// ---- The final ----

const FINAL_REVIEW_OPENING =
  "Before the final, your arc exam. You wrote that the lock made it slower. While one thread is inside the locked block, what is the other one doing?";
const FINAL_REVIEW_ANSWER = "Waiting at the lock until the first one leaves.";
const FINAL_REVIEW_SUMMARY =
  "The arc held, exam included; the cost of the lock is now plain to them: the other thread waits.";
const AUDIT_QUESTIONS = [
  "To start: a program adds one to a number in memory. In your own words, what actually happens?",
  "Two workers share a counter, and someone suggests putting a lock around the addition. What does the lock change, and what does it cost?",
];
const AUDIT_ANSWERS = [
  "It copies the number out, adds one to the copy, and writes it back.",
  "It stops the lost updates, and it makes each addition faster because they don't clash.",
];
const AUDIT_FINDING = "Expects a lock to make the work itself faster";
const TEACH_BACK_QUESTIONS = [
  "Now the teach-back: rebuild the whole thing for me from its foundations, in your own words, as if I hadn't been there. I'll keep asking why, and what if.",
  "Why can't the part doing the arithmetic just change the number where it sits?",
  "And what if the two workers ran on a single core, taking turns: could an update still be lost?",
];
const TEACH_BACK_ANSWERS = [
  "A number lives in memory. To add one, the machine copies it out, changes the copy and puts it back. Two workers can both copy the same value and one addition gets lost.",
  "Because that's how computers work, it just is.",
  "Yes: it can switch from one to the other between copying out and putting back.",
];
const TEACH_BACK_BREAK = "because that's how computers work, it just is";
const FINAL_RECAP =
  "When you started, you thought adding one was a single step; that is gone, and you rebuilt the three moves and the lost update from memory holding one value at a time. One new thing came up: you expect a lock to make the work itself faster, when all it does is make one worker wait for the other.\n\nThe chain broke once. You said the arithmetic part needs a copy because *that's how computers work*; what it rests on is that the part doing the arithmetic only works on values it holds. That link, and the lock, are what a next session would take up.";
const FINAL_LEFT_OFF =
  "The final is done. Open: the lock's cost, and why the arithmetic needs a working copy.";

/** A check's verdict that it landed, confirming the terms the answer used. */
const landed = (reply: string, confirms: { term: string; evidence: string }[] = []) => ({
  thenGenerate: [
    JSON.stringify({
      actions: confirms.map(({ term, evidence }) => ({
        type: "set-term-status",
        term,
        status: "confirmed",
        evidence,
      })),
      verdict: "landed",
      reply,
      freshQuestion: null,
      note: null,
      alreadyHeld: null,
    }),
  ],
});
const decided = (output: object) => ({ thenGenerate: [JSON.stringify(output)] });
const recorded = (text: string, record: object) => ({
  text,
  thenGenerate: [JSON.stringify(record)],
});
const SWEEP = (actions: object[] = []) => decided({ actions });

/** How long a session may look stalled before the seed takes it that a job failed. */
const STALLED_MS = 1500;

interface Snapshot {
  state: { phase: string; plan: string; homework?: string; currentStep: string | null };
  messages: { streaming?: true }[];
  lesson: { steps: { id: string }[] } | null;
  assignments: { id: string; kind: string }[];
  stalled: boolean;
}

/**
 * Seeds every stage for `email` (invited and given `password`, with a placeholder key so the app
 * opens: the canned replies need none). `backend` must run its worker on `models`.
 */
export async function seedStages(
  backend: Pick<Embedded, "db" | "request" | "signIn" | "waitFor">,
  models: Models,
  options: { email: string; password: string; only?: readonly StageKey[] },
): Promise<SeededStage[]> {
  const cookie = await backend.signIn(options.email);

  const call = async (method: string, path: string, body?: object): Promise<unknown> => {
    const response = await backend.request(path, {
      method,
      cookie,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok)
      throw new Error(`${method} ${path}: ${String(response.status)} ${await response.text()}`);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  };
  const post = (path: string, body?: object) => call("POST", path, body);
  const put = (path: string, body: object) => call("PUT", path, body);
  const get = (path: string) => call("GET", path);

  await put("/api/auth/password", { password: options.password });
  const offered = (await get("/api/models")) as Record<string, { id: string }[]>;
  const [provider, list] = Object.entries(offered).find(([, m]) => m.length > 0) ?? [];
  if (!provider || !list?.[0]) throw new Error("no model is offered");
  await put("/api/credentials", {
    provider,
    model: list[0].id,
    apiKey: "stages-placeholder-key",
  });

  const snapshot = async (sessionId: string) =>
    (await get(`/api/sessions/${sessionId}`)) as Snapshot;
  /** Waits for the session to reach a point, failing with what it is at instead. */
  const until = async (sessionId: string, what: string, ok: (s: Snapshot) => boolean) => {
    // A session looks stalled for a moment as one job hands over to the next (it is queued just
    // after the state moves on); one that stays stalled had a job fail.
    let stalledSince: number | null = null;
    try {
      await backend.waitFor(async () => {
        const s = await snapshot(sessionId);
        stalledSince = s.stalled ? (stalledSince ?? Date.now()) : null;
        if (stalledSince !== null && Date.now() - stalledSince > STALLED_MS)
          throw new Error("the session stalled: a job failed");
        return ok(s) && s.messages.every((m) => !m.streaming);
      }, 20_000);
    } catch (error) {
      const s = await snapshot(sessionId);
      throw new Error(
        `waiting for ${what}: ${error instanceof Error ? error.message : String(error)} ` +
          `(phase ${s.state.phase}, plan ${s.state.plan}, homework ${String(s.state.homework)})`,
        { cause: error },
      );
    }
  };
  const messageCount = async (sessionId: string) => (await snapshot(sessionId)).messages.length;
  /** The learner says something in the chat, and waits for the tutor's answer to be stored. */
  const say = async (sessionId: string, text: string, then: (s: Snapshot) => boolean) => {
    const before = await messageCount(sessionId);
    await post(`/api/sessions/${sessionId}/messages`, { text });
    await until(
      sessionId,
      `an answer to "${text}"`,
      (s) => s.messages.length > before + 1 && then(s),
    );
  };

  /** A new track, named by the tutor (the goal is long enough to be named) as the stage. */
  const newTrack = async (title: string) => {
    models.script("track-name", decided({ name: title }));
    const { id } = (await post("/api/tracks", { goal: GOAL })) as { id: string };
    await backend.waitFor(async () => {
      const [track] = await backend.db.select().from(tracks).where(eq(tracks.id, id));
      return track?.titlePending === false;
    });
    return id;
  };
  const startSession = async (trackId: string, body?: object) => {
    const response = await backend.request(`/api/tracks/${trackId}/sessions`, {
      method: "POST",
      cookie,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    // An arc exam still open is warned about once; the learner starts anyway.
    if (response.status === 409) return startSession(trackId, body);
    if (response.status !== 201)
      throw new Error(`starting a session: ${String(response.status)} ${await response.text()}`);
    const { id } = (await response.json()) as { id: string };
    await until(id, "the session's first message", (s) => s.messages.length >= 1);
    return id;
  };
  const answerCheck = (sessionId: string, step: string, text: string) =>
    post(`/api/sessions/${sessionId}/steps/${step}/answer`, { text });

  const assignmentOf = async (sessionId: string, kind: "homework" | "exam") => {
    const found = (await snapshot(sessionId)).assignments.find((a) => a.kind === kind);
    if (!found) throw new Error(`the session set no ${kind}`);
    return found.id;
  };
  /** Writes every task's answer (locking a prediction once written), without handing it in. */
  const writeAnswers = async (
    assignmentId: string,
    answers: Record<string, Record<string, string>>,
  ) => {
    for (const [taskId, fields] of Object.entries(answers)) {
      if ("prediction" in fields) {
        await put(`/api/assignments/${assignmentId}/answers`, {
          taskId,
          fields: { prediction: fields.prediction },
        });
        await post(`/api/assignments/${assignmentId}/tasks/${taskId}/lock`);
      }
      await put(`/api/assignments/${assignmentId}/answers`, { taskId, fields });
    }
  };
  const reviewed = (assignmentId: string) =>
    backend.waitFor(async () => {
      const { review } = (await get(`/api/assignments/${assignmentId}`)) as {
        review: { status: string; failure?: unknown } | null;
      };
      if (review?.status === "failed")
        throw new Error(`the review failed: ${JSON.stringify(review.failure)}`);
      return review?.status === "done";
    }, 20_000);

  /** The first session, up to its homework set. */
  const firstSessionToHomework = async (trackId: string) => {
    models.script("probe", { text: S1_FIRST_QUESTION });
    const sessionId = await startSession(trackId);
    models.script("probe-decision", decided({ actions: [], finished: true }));
    models.script("probe-summary", { text: S1_PROBE_SUMMARY });
    models.script("plan", recorded(S1_PLAN, { actions: S1_PLAN_RECORD }));
    await say(sessionId, S1_PROBE_ANSWER, (s) => s.state.plan === "proposed");
    models.script("lesson", recorded(S1_LESSON, S1_OUTLINE));
    await post(`/api/sessions/${sessionId}/approve-plan`);
    await until(sessionId, "the lesson", (s) => (s.lesson?.steps.length ?? 0) >= 1);
    models.script("check", landed("Yes: it can't change the number where it sits."));
    await answerCheck(sessionId, "s1", "Because it can only change a copy, not memory itself.");
    await until(sessionId, "the second step", (s) => s.state.currentStep === "s2");
    models.script(
      "check",
      landed("That's it: the 6 exists only in the copy.", [
        { term: "working copy", evidence: S1_CHECK_2 },
      ]),
    );
    models.script("homework", recorded(S1_HOMEWORK, S1_HOMEWORK_RECORD));
    await answerCheck(sessionId, "s2", S1_CHECK_2);
    await until(sessionId, "the homework", (s) => s.state.homework === "assigned");
    return { sessionId, homeworkId: await assignmentOf(sessionId, "homework") };
  };

  /** The first session through its close: the homework handed in and reviewed. */
  const firstSession = async (trackId: string) => {
    const { sessionId, homeworkId } = await firstSessionToHomework(trackId);
    await writeAnswers(homeworkId, { t1: S1_ANSWER });
    models.script("review", decided(S1_REVIEW));
    models.script("close", { text: S1_RECAP });
    models.script(
      "term-sweep",
      SWEEP([
        {
          type: "set-term-status",
          term: "working copy",
          status: "confirmed",
          evidence: S1_CHECK_2,
        },
        { type: "close-fix-item", text: "Thinks adding one is a single step" },
      ]),
    );
    models.script("left-off", { text: S1_LEFT_OFF });
    await post(`/api/assignments/${homeworkId}/submit`);
    await until(sessionId, "the first session's close", (s) => s.state.phase === "closed");
    await reviewed(homeworkId);
    return { sessionId, homeworkId };
  };

  /** The second session through its close, which sets the arc exam; it is left open. */
  const secondSession = async (trackId: string) => {
    models.script("opening-review", { text: S2_REVIEW_OPENING });
    const sessionId = await startSession(trackId);
    models.script(
      "opening-review-decision",
      decided({ actions: [], resolved: ["L1"], finished: true }),
    );
    models.script("opening-review-summary", { text: S2_REVIEW_SUMMARY });
    models.script("probe", { text: S2_FIRST_QUESTION });
    await say(sessionId, S2_REVIEW_ANSWER, (s) => s.state.phase === "probe");
    models.script("probe-decision", decided({ actions: [], finished: true }));
    models.script("probe-summary", { text: S2_PROBE_SUMMARY });
    models.script("plan", recorded(S2_PLAN, { actions: S2_PLAN_RECORD }));
    await say(sessionId, S2_PROBE_ANSWER, (s) => s.state.plan === "proposed");
    models.script("lesson", recorded(S2_LESSON, S2_OUTLINE));
    await post(`/api/sessions/${sessionId}/approve-plan`);
    await until(sessionId, "the lesson", (s) => (s.lesson?.steps.length ?? 0) >= 1);
    models.script(
      "check",
      landed("Yes: B put its 6 back over A's.", [{ term: "lost update", evidence: S2_CHECK_1 }]),
    );
    await answerCheck(sessionId, "s1", S2_CHECK_1);
    await until(sessionId, "the second step", (s) => s.state.currentStep === "s2");
    models.script("check", landed("Right: it needs the overlap."));
    models.script("homework", recorded(S2_HOMEWORK, S2_HOMEWORK_RECORD));
    models.script("exam", recorded(EXAM, EXAM_RECORD));
    await answerCheck(sessionId, "s2", "Because the moves only overlap now and then.");
    await until(sessionId, "the homework", (s) => s.state.homework === "assigned");
    const homeworkId = await assignmentOf(sessionId, "homework");
    const examId = await assignmentOf(sessionId, "exam");
    await writeAnswers(homeworkId, { t1: S2_ANSWER });
    models.script("review", decided(S2_REVIEW));
    models.script("close", { text: S2_RECAP });
    models.script("term-sweep", SWEEP());
    models.script("left-off", { text: S2_LEFT_OFF });
    await post(`/api/assignments/${homeworkId}/submit`);
    await until(sessionId, "the second session's close", (s) => s.state.phase === "closed");
    await reviewed(homeworkId);
    return { sessionId, examId };
  };

  /** The arc exam taken whole, handed in and reviewed. */
  const takeExam = async (examId: string) => {
    await writeAnswers(examId, EXAM_ANSWERS);
    models.script("review", decided(EXAM_REVIEW));
    await post(`/api/assignments/${examId}/submit`);
    await reviewed(examId);
  };

  /** The final, up to its teach-back's last question. */
  const finalToTeachBack = async (trackId: string) => {
    models.script("opening-review", { text: FINAL_REVIEW_OPENING });
    const sessionId = await startSession(trackId, { kind: "final" });
    models.script(
      "opening-review-decision",
      decided({ actions: [], resolved: ["L1"], finished: true }),
    );
    models.script("opening-review-summary", { text: FINAL_REVIEW_SUMMARY });
    models.script("audit", { text: AUDIT_QUESTIONS[0] ?? "" });
    await say(sessionId, FINAL_REVIEW_ANSWER, (s) => s.state.phase === "audit");
    models.script("audit-decision", decided({ actions: [], finished: false }));
    models.script("audit", { text: AUDIT_QUESTIONS[1] ?? "" });
    await say(sessionId, AUDIT_ANSWERS[0] ?? "", () => true);
    models.script(
      "audit-decision",
      decided({ actions: [{ type: "add-fix-item", text: AUDIT_FINDING }], finished: true }),
    );
    models.script("teach-back", { text: TEACH_BACK_QUESTIONS[0] ?? "" });
    await say(sessionId, AUDIT_ANSWERS[1] ?? "", (s) => s.state.phase === "teach-back");
    models.script("teach-back-decision", decided({ actions: [], breaks: [], finished: false }));
    models.script("teach-back", { text: TEACH_BACK_QUESTIONS[1] ?? "" });
    await say(sessionId, TEACH_BACK_ANSWERS[0] ?? "", () => true);
    models.script(
      "teach-back-decision",
      decided({
        actions: [],
        breaks: [{ term: "working copy", quote: TEACH_BACK_BREAK }],
        finished: false,
      }),
    );
    models.script("teach-back", { text: TEACH_BACK_QUESTIONS[2] ?? "" });
    await say(sessionId, TEACH_BACK_ANSWERS[1] ?? "", () => true);
    return sessionId;
  };

  /** A track with both sessions closed and the arc exam handed in: the final is offered. */
  const examTaken = async (trackId: string) => {
    await firstSession(trackId);
    const { examId } = await secondSession(trackId);
    await takeExam(examId);
    return examId;
  };

  const seeded: SeededStage[] = [];
  const wanted = (key: StageKey) => !options.only || options.only.includes(key);
  for (const { key, title } of STAGES) {
    if (!wanted(key)) continue;
    const trackId = await newTrack(title);
    let path: string;
    switch (key) {
      case "homework-open": {
        const { homeworkId } = await firstSessionToHomework(trackId);
        path = `/homework/${homeworkId}`;
        break;
      }
      case "homework-reviewed": {
        const { homeworkId } = await firstSession(trackId);
        path = `/homework/${homeworkId}`;
        break;
      }
      case "exam-open": {
        await firstSession(trackId);
        const { examId } = await secondSession(trackId);
        path = `/homework/${examId}`;
        break;
      }
      case "exam-reviewed": {
        path = `/homework/${await examTaken(trackId)}`;
        break;
      }
      case "final-teach-back": {
        await examTaken(trackId);
        path = `/sessions/${await finalToTeachBack(trackId)}`;
        break;
      }
      case "final-finished": {
        await examTaken(trackId);
        const sessionId = await finalToTeachBack(trackId);
        models.script("teach-back-decision", decided({ actions: [], breaks: [], finished: true }));
        models.script("close", { text: FINAL_RECAP });
        models.script(
          "term-sweep",
          SWEEP([
            { type: "close-fix-item", text: "Expects two workers' additions to add up exactly" },
          ]),
        );
        models.script("left-off", { text: FINAL_LEFT_OFF });
        await post(`/api/sessions/${sessionId}/messages`, { text: TEACH_BACK_ANSWERS[2] });
        await until(sessionId, "the final's close", (s) => s.state.phase === "closed");
        path = `/sessions/${sessionId}`;
        break;
      }
    }
    seeded.push({ key, title, trackId, path });
  }
  return seeded;
}
