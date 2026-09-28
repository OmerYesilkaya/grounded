import type { Block, LessonStep } from "@grounded/content";
import type { SessionState } from "@grounded/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useReducer } from "react";
import type { Aside } from "@/lesson/types";
import { api } from "./api";
import { ASIDE_EVENT_TYPES, reduceAsides } from "./asides";

export interface ChatMessage {
  id: string;
  role: "learner" | "tutor";
  kind: "message" | "plan" | "homework" | "recap";
  text: string | null;
  blocks: Block[] | null;
  /** Still arriving: `text` grows until the message is done. */
  streaming?: boolean;
}

export interface CheckEntry {
  id: string;
  stepId: string;
  role: "learner" | "tutor";
  text: string | null;
  blocks: Block[] | null;
  verdict: "landed" | "missed" | null;
}

export interface SessionModel {
  id: string;
  trackId: string;
  state: SessionState;
  messages: ChatMessage[];
  lesson: {
    steps: LessonStep[];
    totalSteps: number;
    failedSteps: { stepId: string; heading: string }[];
    notes: Record<string, string>;
  } | null;
  checks: CheckEntry[];
  /** Questions asked in the margin of the lesson, oldest first. */
  asides: Aside[];
  /** Whether the learner has ever asked one (until then the lesson shows how). */
  hasAskedAside: boolean;
  /** What the tutor is doing right now, oldest first; the last one is the one to show. */
  activities: Activity[];
  lastEventId: number;
  error: string | null;
  /**
   * Waiting on a job nothing is doing (it failed, or died with its worker), which the learner can't
   * set going by writing: "Try again" queues it again. From the snapshot; a job starting clears it.
   */
  stalled: boolean;
}

/**
 * The lesson's steps the learner can read: those written in order from the first, up to the first
 * one missing. A step that failed leaves a gap, and what comes after it rests on it.
 */
export function readableSteps(lesson: SessionModel["lesson"]): LessonStep[] {
  const steps: LessonStep[] = [];
  for (const step of lesson?.steps ?? []) {
    if (step.id !== `s${String(steps.length + 1)}`) break;
    steps.push(step);
  }
  return steps;
}

/** A running job step (api: engine/events.ts), with the reasoning the model shared, if any. */
export interface Activity {
  id: string;
  label: string;
  detail: string | null;
  reasoning: string;
}

/** What GET /api/sessions/:id returns: the model without its local state. */
export type SessionSnapshot = Omit<SessionModel, "error" | "activities"> & {
  activities: { id: string; label: string; detail: string | null; state: "running" | "done" }[];
};

interface Event {
  type: string;
  id: number;
  data: unknown;
}

const emptyLesson = { steps: [], totalSteps: 0, failedSteps: [], notes: {} };

/** Folds one stream event into the session. Replays may repeat events; everything is keyed by id. */
export function reduceSession(model: SessionModel, event: Event): SessionModel {
  if (event.id <= model.lastEventId) return model;
  const next = { ...model, lastEventId: event.id };
  const data = event.data as Record<string, unknown>;
  switch (event.type) {
    case "state":
      return { ...next, state: event.data as SessionState, error: null };
    case "message":
    case "message-start": {
      if (model.messages.some((m) => m.id === data.id)) return next;
      const message: ChatMessage = {
        id: data.id as string,
        role: data.role as ChatMessage["role"],
        kind: data.kind as ChatMessage["kind"],
        text: event.type === "message" ? (data.text as string) : "",
        blocks: null,
        streaming: event.type === "message-start",
      };
      // A tutor message starting is a job at work: whatever failed before is behind it.
      const working = event.type === "message-start" ? { stalled: false, error: null } : {};
      return { ...next, ...working, messages: [...model.messages, message] };
    }
    case "message-delta":
      return {
        ...next,
        messages: model.messages.map((m) =>
          m.id === data.id && m.streaming
            ? { ...m, text: (m.text ?? "") + (data.text as string) }
            : m,
        ),
      };
    case "message-done":
      return {
        ...next,
        messages: model.messages.map((m) =>
          m.id === data.id ? { ...m, blocks: data.blocks as Block[], streaming: false } : m,
        ),
      };
    case "message-retracted":
      return { ...next, messages: model.messages.filter((m) => m.id !== data.id) };
    case "lesson-outline":
      return {
        ...next,
        lesson: { ...(model.lesson ?? emptyLesson), totalSteps: data.totalSteps as number },
      };
    case "lesson-step": {
      const step = data.step as LessonStep;
      const lesson = model.lesson ?? emptyLesson;
      if (lesson.steps.some((s) => s.id === step.id)) return next;
      return { ...next, lesson: { ...lesson, steps: [...lesson.steps, step] } };
    }
    case "lesson-step-failed": {
      const lesson = model.lesson ?? emptyLesson;
      return {
        ...next,
        lesson: {
          ...lesson,
          failedSteps: [...lesson.failedSteps, data as { stepId: string; heading: string }],
        },
      };
    }
    case "lesson-again": {
      // A failed lesson is written again: the steps kept stay, the rest go with their threads.
      const { keep, totalSteps } = data as { keep: string[]; totalSteps: number };
      const lesson = model.lesson ?? emptyLesson;
      const kept = (stepId: string) => keep.includes(stepId);
      return {
        ...next,
        lesson: {
          steps: lesson.steps.filter((s) => kept(s.id)),
          totalSteps,
          failedSteps: [],
          notes: Object.fromEntries(Object.entries(lesson.notes).filter(([id]) => kept(id))),
        },
        checks: model.checks.filter((c) => kept(c.stepId)),
      };
    }
    case "check-message":
      if (model.checks.some((c) => c.id === data.id)) return next;
      return {
        ...next,
        checks: [
          ...model.checks,
          {
            id: data.id as string,
            stepId: data.stepId as string,
            role: data.role as CheckEntry["role"],
            text: (data.text as string | undefined) ?? null,
            blocks: (data.blocks as Block[] | undefined) ?? null,
            verdict: (data.verdict as CheckEntry["verdict"] | undefined) ?? null,
          },
        ],
      };
    case "note": {
      const lesson = model.lesson ?? emptyLesson;
      return {
        ...next,
        lesson: {
          ...lesson,
          notes: { ...lesson.notes, [data.stepId as string]: data.note as string },
        },
      };
    }
    case "activity": {
      const { id, label, detail, state } = data as {
        id: string;
        label: string;
        detail: string | null;
        state: string;
      };
      if (state === "done")
        return { ...next, activities: model.activities.filter((a) => a.id !== id) };
      const existing = model.activities.find((a) => a.id === id);
      if (existing) {
        return {
          ...next,
          activities: model.activities.map((a) => (a.id === id ? { ...a, label, detail } : a)),
        };
      }
      // A job at work: whatever failed before is behind it.
      return {
        ...next,
        stalled: false,
        error: null,
        activities: [...model.activities, { id, label, detail, reasoning: "" }],
      };
    }
    case "activity-reasoning":
      return {
        ...next,
        activities: model.activities.map((a) =>
          a.id === data.id ? { ...a, reasoning: a.reasoning + (data.text as string) } : a,
        ),
      };
    case "error":
      return { ...next, error: data.message as string };
    default: {
      const asides = reduceAsides(model.asides, event.type, event.data);
      if (!asides) return next;
      return { ...next, asides, hasAskedAside: model.hasAskedAside || asides.length > 0 };
    }
  }
}

const EVENT_TYPES = [
  "state",
  "message",
  "message-start",
  "message-delta",
  "message-done",
  "message-retracted",
  "lesson-outline",
  "lesson-step",
  "lesson-step-failed",
  "lesson-again",
  "check-message",
  "note",
  "activity",
  "activity-reasoning",
  ...ASIDE_EVENT_TYPES,
  // Also the name of EventSource's own connection error; the listener tells them apart by data.
  "error",
];

const RECONNECT_MS = 3000;

type Action = { kind: "snapshot"; model: SessionModel } | { kind: "event"; event: Event };

/** The session: a snapshot, then live events from the stream (which resumes by itself). */
export function useSessionModel(sessionId: string): SessionModel | undefined {
  const snapshot = useQuery({
    queryKey: ["session", sessionId],
    queryFn: () => api<SessionSnapshot>(`/api/sessions/${sessionId}`),
    staleTime: Infinity,
  });
  const [model, dispatch] = useReducer((current: SessionModel | undefined, action: Action) => {
    if (action.kind === "snapshot") return action.model;
    return current ? reduceSession(current, action.event) : current;
  }, undefined);

  useEffect(() => {
    if (!snapshot.data) return;
    const activities = snapshot.data.activities.map(({ id, label, detail }) => ({
      id,
      label,
      detail,
      reasoning: "",
    }));
    dispatch({ kind: "snapshot", model: { ...snapshot.data, activities, error: null } });
  }, [snapshot.data]);

  const after = snapshot.data?.lastEventId;
  useEffect(() => {
    if (after === undefined) return;
    let lastSeen = after;
    let source: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const listener = (e: MessageEvent<string>) => {
      // The browser's own connection errors arrive as "error" events without data; they aren't ours.
      if (typeof e.data !== "string") return;
      const id = Number(e.lastEventId);
      lastSeen = Math.max(lastSeen, id);
      dispatch({ kind: "event", event: { type: e.type, id, data: JSON.parse(e.data) as unknown } });
    };
    const open = () => {
      const current = new EventSource(
        `/api/sessions/${sessionId}/stream?after=${String(lastSeen)}`,
      );
      for (const type of EVENT_TYPES) current.addEventListener(type, listener);
      // EventSource reconnects a dropped stream by itself, but gives up for good when a reconnect gets
      // an error response (a 502 while the API restarts); then open a new one from the last event.
      current.addEventListener("error", () => {
        if (current.readyState === EventSource.CLOSED) retry = setTimeout(open, RECONNECT_MS);
      });
      source = current;
    };
    open();
    return () => {
      clearTimeout(retry);
      source?.close();
    };
  }, [sessionId, after]);

  return model;
}
