/*
 * What the admin panel's routes answer (design §10.1): shared by the API, which builds them
 * (apps/api/src/admin), and the panel (apps/admin), which shows them. Types only, so the browser
 * may import them.
 */

import type { CallVerdict } from "./verdict.js";

/** A JSON value, as a model call's content is stored. */
export type Json = null | string | number | boolean | Json[] | { [key: string]: Json };

/** What a model call answered, as stored (`model_calls.reply`). */
export interface CallReply {
  content: Json[];
  finishReason?: Json;
  providerMetadata?: Json;
}

/** The models and method versions calls were made with, for the panel's filters. */
export interface FilterOptions {
  models: { model: string; calls: number }[];
  methods: { version: string; calls: number; firstSeen: string; lastSeen: string }[];
}

/** A page of the sessions list; `next` is the `before` of the page after it. */
export interface SessionsPage {
  sessions: SessionRow[];
  next: string | null;
}

export interface Overview {
  totals: { learners: number; sessions: number; closed: number; calls: number; costUsd: number };
  checks: {
    /** Steps whose check was answered at least once. */
    checked: number;
    firstTry: number;
    misses: number;
    /** Steps continued past while still shaky. */
    settling: number;
    byModel: { model: string; checked: number; firstTry: number; misses: number }[];
  };
  validators: {
    byPurpose: {
      purpose: string;
      model: string;
      judged: number;
      rewrites: number;
      passed: number;
    }[];
    issues: {
      code: string;
      purpose: string;
      model: string;
      count: number;
      sessions: number;
      example: string;
    }[];
  };
  failures: {
    calls: { kind: string; model: string; count: number }[];
    /** Errors the session showed the learner. */
    shown: number;
    latestShown: { sessionId: string; learner: number; message: string; at: string }[];
    failedSteps: number;
    unanswered: { checks: number; asides: number; reviewThreads: number };
  };
  asides: {
    total: number;
    latest: {
      id: string;
      sessionId: string;
      learner: number;
      stepId: string;
      quote: string;
      question: string | null;
      at: string;
    }[];
  };
  alreadyHeld: {
    total: number;
    latest: { sessionId: string; learner: number; stepId: string; what: string; at: string }[];
  };
  sessions: {
    /** Sessions by the furthest phase they reached. */
    furthest: { phase: string; sessions: number }[];
    /** Open sessions with nothing happening for a day, by the phase they stopped in. */
    idle: { phase: string; sessions: number }[];
    /** Sessions by how many plans the tutor proposed (1: approved as first proposed). */
    plans: { plans: number; sessions: number }[];
  };
  homework: {
    assignments: {
      kind: string;
      total: number;
      handedIn: number;
      putOff: number;
      folded: number;
      open: number;
    }[];
    reviews: { status: string; count: number }[];
  };
  calls: {
    byPurpose: {
      purpose: string;
      calls: number;
      failures: number;
      p50Ms: number | null;
      p90Ms: number | null;
      costUsd: number;
    }[];
    byModel: { model: string; calls: number; failures: number; costUsd: number }[];
  };
}

export interface SessionRow {
  id: string;
  learner: number;
  trackId: string;
  trackTitle: string;
  kind: "normal" | "final";
  phase: string;
  startedAt: string;
  closedAt: string | null;
  lastActivity: string;
  models: string[];
  calls: number;
  failedCalls: number;
  costUsd: number;
  checked: number;
  firstTry: number;
  misses: number;
  asides: number;
  rewrites: number;
  issues: number;
  errors: number;
}

export interface ReplayCall {
  id: string;
  purpose: string;
  model: string;
  status: "ok" | "error";
  errorKind: string | null;
  durationMs: number | null;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  methodVersion: string | null;
  /** Whether its content was stored (calls from before every call was kept have none). */
  stored: boolean;
  verdict: CallVerdict | null;
}

export type TimelineItem = { at: string } & (
  | { kind: "message"; role: "learner" | "tutor"; messageKind: string; text: string }
  | { kind: "phase"; phase: string }
  | { kind: "error"; message: string }
  | {
      kind: "outline";
      title: string | null;
      steps: { heading: string; establishes: string; introduces: string[]; restsOn: string[] }[];
    }
  | { kind: "step"; stepId: string; heading: string; text: string; source: string | null }
  | {
      kind: "check";
      stepId: string;
      role: "learner" | "tutor";
      text: string;
      verdict: "landed" | "missed" | null;
      failure: string | null;
    }
  | {
      kind: "aside";
      stepId: string;
      quote: string;
      tangent: string | null;
      thread: { role: "learner" | "tutor"; text: string; failure: string | null }[];
    }
  | { kind: "research"; for: "plan" | "lesson"; notes: string; searches: string[]; sources: number }
  | {
      kind: "assignment";
      assignmentKind: string;
      title: string;
      tasks: string[];
      checklist: string[];
      submittedAt: string | null;
      snoozedUntil: string | null;
      folded: boolean;
      review: {
        status: string;
        marks: { item: string; mark: string; note: string }[];
        comments: { quote: string; thread: { role: string; text: string }[] }[];
      } | null;
    }
  | { kind: "call"; call: ReplayCall }
);

export interface Replay {
  session: {
    id: string;
    learner: number;
    kind: "normal" | "final";
    phase: string;
    startedAt: string;
    closedAt: string | null;
    probeSummary: string | null;
    reviewSummary: string | null;
    earlierSummary: string | null;
  };
  track: { id: string; title: string; goal: string; language: string | null };
  lesson: {
    /** How each step stands: passed, settling, open… with its misses. */
    steps: { id: string; status: string; misses: number }[];
    failedSteps: { stepId: string; heading: string }[];
    notes: Record<string, string>;
    alreadyHeld: Record<string, string>;
  } | null;
  timeline: TimelineItem[];
}

/** A model call in full, for the admin panel's replay (design §4.4, §10.1). */
export interface CallDetail {
  id: string;
  sessionId: string | null;
  trackId: string | null;
  learner: number;
  at: string;
  purpose: string;
  provider: string;
  model: string;
  status: "ok" | "error";
  errorKind: string | null;
  durationMs: number | null;
  tokens: { input: number; cachedInput: number; cacheWrite: number; output: number };
  costUsd: number | null;
  methodVersion: string | null;
  release: string | null;
  /** Null when the call's content wasn't stored (before every call was kept). */
  content: {
    prompt: Json[];
    responseFormat: Json;
    tools: Json[] | null;
    settings: Record<string, Json>;
    reply: CallReply | null;
    error: Json;
    verdict: CallVerdict | null;
  } | null;
}

/** The learners, by number (design §10.1): never their email, which is asked for one at a time. */
export interface LearnerRow {
  learner: number;
  joinedAt: string;
  tracks: { id: string; title: string; sessions: number }[];
  sessions: number;
  lastActivity: string | null;
}
