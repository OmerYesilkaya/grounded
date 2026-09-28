import { asc, eq, sessionEvents } from "@grounded/db";
import { expect } from "vitest";
import { invite } from "../allowlist.js";
import type { ActivityEvent } from "../engine/events.js";
import type { createTestHarness } from "./harness.js";
import type { scriptedModels } from "./scripted-models.js";

type Harness = ReturnType<typeof createTestHarness>;
type Models = ReturnType<typeof scriptedModels>;

export interface Snapshot {
  state: {
    phase: string;
    plan: string;
    currentStep: string | null;
    lesson: { status: string };
    steps: Record<string, { status: string; misses: number; offerGate: boolean } | undefined>;
  };
  messages: {
    role: string;
    kind: string;
    text: string | null;
    blocks: { type: string }[] | null;
    /** A tutor message still being written. */
    streaming?: true;
  }[];
  lesson: { steps: { id: string }[]; totalSteps: number; notes: Record<string, string> } | null;
  checks: { stepId: string; role: string; text: string | null; verdict: string | null }[];
  activities: ActivityEvent[];
}

/**
 * Whether the snapshot holds this many messages, all stored. A message still being written counts
 * among the messages too, so waiting on the count alone can end before it is stored.
 */
export const storedMessages = (count: number) => (s: Snapshot) =>
  s.messages.length === count && s.messages.every((m) => !m.streaming);

export const FIRST_QUESTION =
  "In your own words: what happens when a program adds one to a number?";
export const PLAN_TEXT =
  "We start from what you already hold and build towards why a counter can lose updates.";
export const PLAN_ACTIONS = [
  { type: "add-planned-term", term: "working copy", restsOn: [] },
  { type: "add-planned-term", term: "lost update", restsOn: ["working copy"] },
  { type: "add-to-arc", arc: "Concurrency", terms: ["working copy", "lost update"] },
];

export const PROBE_SUMMARY =
  "Knowledge ends at: thinks adding one is a single step. Goal: understand why a shared counter loses updates.";

/**
 * The probe's decision ("probe-decision") on a turn that goes on: the record of what the answers
 * showed. The next question is the "probe" model's.
 */
export const probeGoesOn = (actions: object[] = []) => ({
  thenGenerate: [JSON.stringify({ actions, finished: false, summary: null })],
});

/** The probe's decision ("probe-decision") that ends the probe: the record and its conclusion. */
export const probeFinished = (summary: string = PROBE_SUMMARY, actions: object[] = []) => ({
  thenGenerate: [JSON.stringify({ actions, finished: true, summary })],
});

/** A plan attempt: the plan's message, then the structured record of its actions. */
export const planAttempt = (text: string, actions: object[] = PLAN_ACTIONS) => ({
  text,
  thenGenerate: [JSON.stringify({ actions })],
});

/** Common journeys through a session, on the real API with scripted models. */
export function createFlows(t: Harness, models: Models) {
  const snapshot = async (cookie: string, sessionId: string) =>
    (await (await t.request(`/api/sessions/${sessionId}`, { cookie })).json()) as Snapshot;

  const until = (cookie: string, sessionId: string, ok: (s: Snapshot) => boolean) =>
    t.waitFor(async () => ok(await snapshot(cookie, sessionId)));

  const learner = async () => {
    await invite(t.db, "ada@example.com");
    const cookie = await t.signIn("ada@example.com");
    const response = await t.request("/api/tracks", {
      method: "POST",
      cookie,
      body: JSON.stringify({ goal: "Concurrency" }),
    });
    const track = (await response.json()) as { id: string };
    return { cookie, trackId: track.id };
  };

  const startedSession = async () => {
    const { cookie, trackId } = await learner();
    models.script("probe", { text: FIRST_QUESTION });
    const started = await t.request(`/api/tracks/${trackId}/sessions`, { method: "POST", cookie });
    expect(started.status).toBe(201);
    const { id } = (await started.json()) as { id: string };
    await until(cookie, id, storedMessages(1));
    return { cookie, trackId, sessionId: id };
  };

  const planned = async () => {
    const session = await startedSession();
    models.script(
      "probe-decision",
      probeFinished(PROBE_SUMMARY, [
        { type: "add-fix-item", text: "Thinks adding one is a single step" },
      ]),
    );
    models.script("plan", planAttempt(PLAN_TEXT));
    await t.request(`/api/sessions/${session.sessionId}/messages`, {
      method: "POST",
      cookie: session.cookie,
      body: JSON.stringify({ text: "it just adds one" }),
    });
    await until(session.cookie, session.sessionId, (s) => s.state.plan === "proposed");
    return session;
  };

  /** The session's activities in the order they started, each as its latest event left it. */
  const activities = async (sessionId: string) => {
    const rows = await t.db
      .select()
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, sessionId))
      .orderBy(asc(sessionEvents.id));
    const latest = new Map<string, ActivityEvent>();
    for (const row of rows) {
      if (row.type !== "activity") continue;
      const activity = row.data as ActivityEvent;
      latest.set(activity.id, activity);
    }
    return [...latest.values()];
  };

  return { snapshot, until, learner, startedSession, planned, activities };
}
