import { APICallError } from "@ai-sdk/provider";
import { asc, asides, eq, sessionEvents, termEvents, terms, tracks } from "@grounded/db";
import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it } from "vitest";
import { createAside } from "./engine/asides.js";
import { publish } from "./engine/events.js";
import { recoverAbandonedWork } from "./engine/recovery.js";
import { createFlows } from "./test/flows.js";
import { createTestHarness } from "./test/harness.js";
import { scriptedModels } from "./test/scripted-models.js";

const models = scriptedModels();
// Every model the jobs ask for, with its role: asides use the cheaper one.
const requests: { purpose: string; role: string }[] = [];
const t = createTestHarness({
  models: {
    ...models.access,
    model: (request) => {
      requests.push({ purpose: request.purpose, role: request.role });
      return models.access.model(request);
    },
  },
});
const { snapshot, until, planned } = createFlows(t, models);

beforeEach(() => {
  models.reset();
  requests.length = 0;
});

const OUTLINE = {
  title: "Why two writers lose an update",
  steps: [
    {
      heading: "Adding one is three moves",
      establishes: "copy, change, put back",
      introduces: ["working copy"],
      restsOn: [],
    },
    {
      heading: "Two workers",
      establishes: "interleaving loses an update",
      introduces: ["lost update"],
      restsOn: ["working copy"],
    },
  ],
};
const LESSON = [
  "## Adding one is three moves\n\nThe value is copied out into a working copy, changed, and put back.\n\n:::check\nWhat is in memory meanwhile?\n:::",
  "## Two workers\n\nBoth copy 5, and one addition vanishes: a lost update.\n\n:::check\nWhy 6 and not 7?\n:::",
].join("\n\n");

const ANCHOR = {
  blockId: "s1.b2",
  quote: "copied out",
  prefix: "The value is ",
  suffix: " into a working copy",
};
const ANSWER =
  "The number stays where it is in memory; the part doing the sum works on a copy of it.";

interface AsideView {
  id: string;
  stepId: string;
  anchor: typeof ANCHOR;
  tangent: string | null;
  saved: boolean;
  messages: { role: string; text: string | null; blocks: { type: string }[] | null }[];
  draft: string | null;
}
type WithAsides = Awaited<ReturnType<typeof snapshot>> & {
  asides: AsideView[];
  hasAskedAside: boolean;
};

async function inLesson() {
  const session = await planned();
  models.script("lesson", { text: LESSON, thenGenerate: [JSON.stringify(OUTLINE)] });
  await t.request(`/api/sessions/${session.sessionId}/approve-plan`, {
    method: "POST",
    cookie: session.cookie,
  });
  await until(session.cookie, session.sessionId, (s) => s.lesson?.steps.length === 2);
  const view = async () => (await snapshot(session.cookie, session.sessionId)) as WithAsides;
  const settled = (count: number) =>
    t.waitFor(async () => {
      const s = await view();
      return s.asides.every((a) => a.messages.length === count) && s.asides.length > 0;
    });
  return { ...session, view, settled };
}

/** The aside's answer, then its record: what the question showed, and any tangent. */
const answerScript = (
  text: string,
  record: { evidence?: { term: string; evidence: string }[]; tangent?: string | null } = {},
) => ({
  text,
  thenGenerate: [JSON.stringify({ evidence: [], tangent: null, ...record })],
});

const ask = (cookie: string, sessionId: string, body: object) =>
  t.request(`/api/sessions/${sessionId}/asides`, {
    method: "POST",
    cookie,
    body: JSON.stringify(body),
  });

const followUp = (cookie: string, sessionId: string, asideId: string, text: string) =>
  t.request(`/api/sessions/${sessionId}/asides/${asideId}/messages`, {
    method: "POST",
    cookie,
    body: JSON.stringify({ text }),
  });

const asideCall = (n = 0) => models.used.filter((u) => u.purpose === "aside")[n]?.model;

describe("asking about a passage", () => {
  it("answers in the card with the cheaper model, streamed as it is written", async () => {
    const { cookie, sessionId, view, settled } = await inLesson();
    expect((await view()).hasAskedAside).toBe(false);
    models.script("aside", answerScript(ANSWER));
    models.script("aside-record", answerScript("", {}));

    const asked = await ask(cookie, sessionId, { anchor: ANCHOR, text: "Copied out to where?" });
    expect(asked.status).toBe(201);
    const { id } = (await asked.json()) as { id: string };
    await settled(2);

    const s = await view();
    expect(s.hasAskedAside).toBe(true);
    expect(s.asides).toEqual([
      {
        id,
        stepId: "s1",
        anchor: ANCHOR,
        tangent: null,
        saved: false,
        draft: null,
        messages: [
          {
            id: expect.any(String) as string,
            asideId: id,
            role: "learner",
            text: "Copied out to where?",
            blocks: null,
          },
          {
            id: expect.any(String) as string,
            asideId: id,
            role: "tutor",
            text: null,
            blocks: [expect.objectContaining({ type: "paragraph" })],
          },
        ],
      },
    ]);
    expect(requests.filter((r) => r.purpose.startsWith("aside"))).toEqual([
      { purpose: "aside", role: "cheap" },
      { purpose: "aside-record", role: "cheap" },
    ]);
    const deltas = await t.db
      .select()
      .from(sessionEvents)
      .where(eq(sessionEvents.type, "aside-delta"))
      .orderBy(asc(sessionEvents.id));
    expect(deltas.map((e) => (e.data as { text: string }).text).join("")).toBe(ANSWER);
  });

  it("gives the tutor the passage, the whole lesson with what is still locked, and the aside's method", async () => {
    const { cookie, sessionId, settled } = await inLesson();
    models.script("aside", answerScript(ANSWER));
    models.script("aside-record", answerScript(""));
    await ask(cookie, sessionId, { anchor: ANCHOR, text: "Copied out to where?" });
    await settled(2);

    const prompt = JSON.stringify(asideCall()?.doStreamCalls[0]?.prompt);
    expect(prompt).toContain("Asides — answering in the margin");
    expect(prompt).toContain("## The lesson");
    expect(prompt).toContain("### Step 1 (the learner can read it)");
    expect(prompt).toContain(
      "### Step 2 (still locked: the learner hasn't reached it; don't spoil it)",
    );
    expect(prompt).toContain("Both copy 5, and one addition vanishes");
    expect(prompt).toContain("…The value is «copied out» into a working copy…");
    expect(prompt).toContain('In step 1, \\"Adding one is three moves\\"');
    expect(prompt).toContain("diagrams and steppers");
    expect(prompt).toContain("| working copy | planned |");
    expect(prompt).toContain("Copied out to where?");
  });

  it("carries earlier asides and follow-ups in the same card", async () => {
    const { cookie, sessionId, view, settled } = await inLesson();
    models.script("aside", answerScript(ANSWER), answerScript("Yes: two separate places."));
    models.script("aside-record", answerScript(""), answerScript(""));
    const first = (await (
      await ask(cookie, sessionId, { anchor: ANCHOR, text: "Copied out to where?" })
    ).json()) as { id: string };
    await settled(2);
    expect(
      (await followUp(cookie, sessionId, first.id, "So memory and the copy differ?")).status,
    ).toBe(201);
    await settled(4);
    const followed = JSON.stringify(asideCall(1)?.doStreamCalls[0]?.prompt);
    expect(followed).toContain("Copied out to where?");
    expect(followed).toContain("So memory and the copy differ?");

    models.script("aside", answerScript("It is put back afterwards."));
    models.script("aside-record", answerScript(""));
    await ask(cookie, sessionId, {
      anchor: { blockId: "s1.b2", quote: "put back", prefix: "changed, and ", suffix: "." },
      text: "When is it put back?",
    });
    await t.waitFor(async () => (await view()).asides[1]?.messages.length === 2);
    const second = JSON.stringify(asideCall(2)?.doStreamCalls[0]?.prompt);
    expect(second).toContain("## Earlier asides on this lesson");
    expect(second).toContain("### On step 1: «copied out»");
    expect(second).toContain("Learner: So memory and the copy differ?");
  });

  it("refuses a follow-up while the last question is being answered", async () => {
    const { cookie, sessionId, settled } = await inLesson();
    const aside = await createAside(t.db, sessionId, {
      stepId: "s1",
      anchor: ANCHOR,
      question: "Copied out to where?",
    });
    expect((await followUp(cookie, sessionId, aside.aside.id, "And?")).status).toBe(409);
    models.script("aside", answerScript(ANSWER));
    models.script("aside-record", answerScript(""));
    await t.queue.enqueue("aside", { sessionId, asideId: aside.aside.id });
    await settled(2);
    expect((await followUp(cookie, sessionId, aside.aside.id, "And?")).status).toBe(201);
  });

  it("takes a passage only from a step the learner can read, and only while the session is open", async () => {
    const { cookie, sessionId } = await inLesson();
    const locked = { ...ANCHOR, blockId: "s2.b2" };
    expect((await ask(cookie, sessionId, { anchor: locked, text: "What vanishes?" })).status).toBe(
      409,
    );
    expect((await ask(cookie, sessionId, { anchor: ANCHOR, text: " " })).status).toBe(400);
    expect(
      (await ask(cookie, sessionId, { anchor: { ...ANCHOR, blockId: "b2" }, text: "Hm?" })).status,
    ).toBe(400);
  });

  it("rewrites an answer that uses a term the learner hasn't reached", async () => {
    const { cookie, sessionId, view, settled } = await inLesson();
    models.script("aside", {
      text: "That is how a lost update happens.",
      thenGenerate: [
        "That is how one addition can vanish.",
        JSON.stringify({ evidence: [], tangent: null }),
      ],
    });
    models.script("aside-record", answerScript(""));
    await ask(cookie, sessionId, { anchor: ANCHOR, text: "Why does it matter?" });
    await settled(2);
    const [aside] = (await view()).asides;
    expect(JSON.stringify(aside?.messages[1]?.blocks)).toContain("one addition can vanish");
  });

  it("says so in the card when the answer fails, and the learner can ask again", async () => {
    const { cookie, sessionId, view, settled } = await inLesson();
    const failing = new MockLanguageModelV4({
      doStream: () =>
        Promise.reject(
          new APICallError({
            message: "Overloaded",
            url: "https://api.anthropic.com/v1/messages",
            requestBodyValues: {},
            statusCode: 529,
            isRetryable: false,
          }),
        ),
    });
    models.script("aside", failing, answerScript(ANSWER));
    models.script("aside-record", answerScript(""));
    const { id } = (await (
      await ask(cookie, sessionId, { anchor: ANCHOR, text: "Copied out to where?" })
    ).json()) as { id: string };
    await settled(2);
    const failed = (await view()).asides[0]?.messages[1];
    expect(JSON.stringify(failed?.blocks)).toContain("That didn't go through.");
    expect((await followUp(cookie, sessionId, id, "Copied out to where?")).status).toBe(201);
    await settled(4);
    // The session itself goes on: no error for the lesson page.
    const errors = await t.db.select().from(sessionEvents).where(eq(sessionEvents.type, "error"));
    expect(errors).toEqual([]);
  });
});

describe("what an aside records", () => {
  it("keeps what the question showed about a term as evidence, without changing its status", async () => {
    const { cookie, sessionId, settled } = await inLesson();
    models.script("aside", answerScript(ANSWER));
    models.script(
      "aside-record",
      answerScript("", {
        evidence: [
          {
            term: "Working Copy",
            evidence: 'Asked where the value is copied: "copied out to where?"',
          },
          { term: "no such term", evidence: "ignored" },
        ],
      }),
    );
    await ask(cookie, sessionId, { anchor: ANCHOR, text: "Copied out to where?" });
    await settled(2);
    await t.waitFor(
      async () =>
        (await t.db.select().from(termEvents).where(eq(termEvents.source, "aside"))).length > 0,
    );
    const events = await t.db
      .select({
        term: terms.term,
        from: termEvents.fromStatus,
        to: termEvents.toStatus,
        evidence: termEvents.evidence,
      })
      .from(termEvents)
      .innerJoin(terms, eq(terms.id, termEvents.termId))
      .where(eq(termEvents.source, "aside"));
    expect(events).toEqual([
      {
        term: "working copy",
        from: "planned",
        to: "planned",
        evidence: 'Asked where the value is copied: "copied out to where?"',
      },
    ]);
    const [term] = await t.db.select().from(terms).where(eq(terms.term, "working copy"));
    expect(term?.status).toBe("planned");
  });

  it("offers a tangent, which the learner can save into the plan for a future session", async () => {
    const { cookie, sessionId, trackId, view, settled } = await inLesson();
    models.script(
      "aside",
      answerScript(`${ANSWER} Want to save how databases avoid this for later?`),
    );
    models.script(
      "aside-record",
      answerScript("", { tangent: "How databases avoid lost updates" }),
    );
    const { id } = (await (
      await ask(cookie, sessionId, { anchor: ANCHOR, text: "Do databases have this problem?" })
    ).json()) as { id: string };
    await settled(2);
    await t.waitFor(async () => (await view()).asides[0]?.tangent !== null);

    const save = () =>
      t.request(`/api/sessions/${sessionId}/asides/${id}/save`, { method: "POST", cookie });
    expect((await save()).status).toBe(200);
    expect((await save()).status).toBe(200);
    expect((await view()).asides[0]).toMatchObject({
      tangent: "How databases avoid lost updates",
      saved: true,
    });
    const [track] = await t.db.select().from(tracks).where(eq(tracks.id, trackId));
    const notes = track?.plan.notes ?? "";
    expect(notes.match(/How databases avoid lost updates/g)).toHaveLength(1);
    expect(notes).toContain('They asked: "Do databases have this problem?"');
  });

  it("has nothing to save without a tangent", async () => {
    const { cookie, sessionId, settled } = await inLesson();
    models.script("aside", answerScript(ANSWER));
    models.script("aside-record", answerScript(""));
    const { id } = (await (
      await ask(cookie, sessionId, { anchor: ANCHOR, text: "Copied out to where?" })
    ).json()) as { id: string };
    await settled(2);
    const saved = await t.request(`/api/sessions/${sessionId}/asides/${id}/save`, {
      method: "POST",
      cookie,
    });
    expect(saved.status).toBe(409);
    const [row] = await t.db.select().from(asides).where(eq(asides.id, id));
    expect(row?.savedAt).toBeNull();
  });
});

describe("an aside's answer on the way", () => {
  it("comes with the snapshot as far as it is written", async () => {
    const { sessionId, view } = await inLesson();
    const { aside, question } = await createAside(t.db, sessionId, {
      stepId: "s1",
      anchor: ANCHOR,
      question: "Copied out to where?",
    });
    for (const text of ["The number ", "stays put."])
      await publish(t.db, sessionId, "aside-delta", {
        asideId: aside.id,
        replyTo: question.id,
        text,
      });
    expect((await view()).asides[0]?.draft).toBe("The number stays put.");
  });

  it("is told it didn't go through when its job died, without an error for the session", async () => {
    const { sessionId, view } = await inLesson();
    await createAside(t.db, sessionId, { stepId: "s1", anchor: ANCHOR, question: "Where to?" });
    const [recovered] = await recoverAbandonedWork(t.db, { quietForMs: 0 });
    expect(recovered).toMatchObject({ sessionId, asides: 1, messages: 0, checks: [] });
    const s = await view();
    expect(JSON.stringify(s.asides[0]?.messages[1]?.blocks)).toContain("That didn't go through.");
    const errors = await t.db.select().from(sessionEvents).where(eq(sessionEvents.type, "error"));
    expect(errors).toEqual([]);
    expect(await recoverAbandonedWork(t.db, { quietForMs: 0 })).toEqual([]);
  });
});

describe("asides after the lesson", () => {
  it("reach the check on their step, and the homework and the close", async () => {
    const { cookie, sessionId, settled } = await inLesson();
    models.script("aside", answerScript(ANSWER));
    models.script("aside-record", answerScript(""));
    await ask(cookie, sessionId, { anchor: ANCHOR, text: "Copied out to where?" });
    await settled(2);

    const verdict = JSON.stringify({
      verdict: "landed",
      reply: "Yes.",
      freshQuestion: null,
      note: null,
      alreadyHeld: null,
      actions: [],
    });
    models.script("check", { thenGenerate: [verdict] }, { thenGenerate: [verdict] });
    models.script("homework", { text: "Explain it to a friend." });
    models.script("close", { text: "We built it." });
    models.script("term-sweep", { thenGenerate: [JSON.stringify({ actions: [] })] });
    models.script("left-off", { text: "Owed: the homework." });
    for (const id of ["s1", "s2"]) {
      await t.request(`/api/sessions/${sessionId}/steps/${id}/answer`, {
        method: "POST",
        cookie,
        body: JSON.stringify({ text: "an answer" }),
      });
      await until(cookie, sessionId, (s) => s.state.steps[id]?.status === "passed");
    }
    await until(cookie, sessionId, (s) => s.state.phase === "closed");

    const promptOf = (purpose: string, n = 0) => {
      const model = models.used.filter((u) => u.purpose === purpose)[n]?.model;
      return JSON.stringify(model?.doGenerateCalls[0]?.prompt ?? model?.doStreamCalls[0]?.prompt);
    };
    const heading = "Questions the learner asked in the margin of the lesson";
    expect(promptOf("check", 0)).toContain(heading);
    expect(promptOf("check", 0)).toContain("Learner: Copied out to where?");
    // The second check covers step 2 only, where nothing was asked.
    expect(promptOf("check", 1)).not.toContain(heading);
    for (const purpose of ["homework", "close", "term-sweep", "left-off"])
      expect(promptOf(purpose), purpose).toContain("### On step 1: «copied out»");

    // The session is closed: its lesson takes no more questions.
    expect((await ask(cookie, sessionId, { anchor: ANCHOR, text: "One more?" })).status).toBe(409);
  });
});
