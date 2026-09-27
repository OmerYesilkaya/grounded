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
  }[];
  lesson: { steps: { id: string }[]; totalSteps: number; notes: Record<string, string> } | null;
  checks: { stepId: string; role: string; text: string | null; verdict: string | null }[];
  activities: ActivityEvent[];
}

export const FIRST_QUESTION =
  "In your own words: what happens when a program adds one to a number?";
export const PLAN_TEXT =
  "We start from what you already hold and build towards why a counter can lose updates.";
export const PLAN_ACTIONS = [
  { type: "add-planned-term", term: "working copy", restsOn: [] },
  { type: "add-planned-term", term: "lost update", restsOn: ["working copy"] },
  {
    type: "set-plan",
    arcs: [{ title: "Concurrency", terms: ["working copy", "lost update"] }],
    notes: "",
  },
];

/** A probe turn: the message, then the structured record of what it showed and whether it's done. */
export const probeTurn = (text: string, decision: { actions?: object[]; finished: boolean }) => ({
  text,
  thenGenerate: [JSON.stringify({ actions: [], ...decision })],
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
      body: JSON.stringify({ title: "Concurrency" }),
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
    await until(cookie, id, (s) => s.messages.length === 1);
    return { cookie, trackId, sessionId: id };
  };

  const planned = async () => {
    const session = await startedSession();
    models.script(
      "probe",
      probeTurn("Thanks, that's clear.", {
        actions: [{ type: "add-fix-item", text: "Thinks adding one is a single step" }],
        finished: true,
      }),
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
