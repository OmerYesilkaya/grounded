import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { Block, LessonStep } from "@grounded/content";
import type {
  Answers,
  AsideAnchor,
  AssignmentKind,
  AssignmentTask,
  AttachmentKind,
  ChecklistItem,
  ChecklistMark,
  ProbeVerdict,
  ReviewAnchor,
  SessionState,
  StoredLessonOutline,
  TeachBackBreak,
} from "@grounded/core";
import type { SealedSecret } from "@grounded/crypto";
import { v7 as uuidv7 } from "uuid";

const id = () =>
  uuid("id")
    .primaryKey()
    .$defaultFn(() => uuidv7());
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdateFn(() => new Date());

// ---------------------------------------------------------------------------------------------
// Auth (design §4.3): who may sign in, and who has
// ---------------------------------------------------------------------------------------------

/** A learner, created on their first sign-in. Signed-in browsers hold a cookie with the id. */
export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * Who may sign in: an email here signs in by entering it. Managed with `pnpm invite` /
 * `pnpm revoke` (or a row added by hand). Emails are stored lowercased.
 */
export const allowlist = pgTable("allowlist", {
  email: text("email").primaryKey(),
  invitedAt: timestamp("invited_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------------------------
// Credentials and usage
// ---------------------------------------------------------------------------------------------

export type ProviderId = "anthropic" | "openai" | "google" | "deepseek";
/** own_key: the learner's key. sponsored: someone else pays for this learner (design §4.3). */
export type CredentialSource = "own_key" | "sponsored";

/** One credential per learner in v1. */
export const credentials = pgTable("credentials", {
  id: id(),
  userId: uuid("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  source: text("source").$type<CredentialSource>().notNull().default("own_key"),
  provider: text("provider").$type<ProviderId>().notNull(),
  /** Sealed by @grounded/crypto, bound to user_id; the plaintext key is never stored. */
  sealedKey: jsonb("sealed_key").$type<SealedSecret>().notNull(),
  /** The key's last four characters, for "sk-…a1b2" in settings. */
  keyHint: text("key_hint").notNull(),
  /** The learner's chosen model for this provider, from the model list. */
  model: text("model").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * One row per model call (design §4.4). Costs are estimated from the model list's prices and shown
 * per session and per month (the usage page).
 */
export const usageEvents = pgTable(
  "usage_events",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /**
     * The track and session the call was made for, where it had them (naming a track has no
     * session, an import neither). Null for calls recorded before they were kept. No foreign keys:
     * the calls outlive a deleted track (they record what was spent, design §4.5), and a job's call
     * still in flight when its track is deleted is recorded all the same.
     */
    trackId: uuid("track_id"),
    sessionId: uuid("session_id"),
    provider: text("provider").$type<ProviderId>().notNull(),
    model: text("model").notNull(),
    /** What the call was for, e.g. "lesson", "check", "aside". */
    purpose: text("purpose").notNull(),
    /** Every input token, those read from and written to the provider's cache included. */
    inputTokens: integer("input_tokens").notNull(),
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    /** Input written to the provider's cache: Anthropic bills it above the base rate. */
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull(),
    /** Failed calls are recorded too, with the kind of failure the learner was shown. */
    status: text("status").$type<"ok" | "error">().notNull().default("ok"),
    errorKind: text("error_kind"),
    /**
     * How long this attempt took, from the request to its last part (a stream's finish) or its
     * failure. Null for calls recorded before it was measured.
     */
    durationMs: integer("duration_ms"),
    createdAt: createdAt(),
  },
  (table) => [
    index("usage_events_user_time").on(table.userId, table.createdAt),
    index("usage_events_session").on(table.sessionId),
  ],
);

/** A JSON value as the model call's content is stored (files named, not copied). */
export type StoredJson =
  null | string | number | boolean | StoredJson[] | { [key: string]: StoredJson };

/** What a model call answered, as the middleware saw it (design §4.4). */
export interface StoredReply {
  /** The reply's parts in order: text, reasoning, tool calls with their inputs, tool results… */
  content: StoredJson[];
  /** How the call ended, as the provider said (a failed call has none). */
  finishReason?: StoredJson;
  /** What the provider returned beside the parts (Gemini's search grounding, cache usage…). */
  providerMetadata?: StoredJson;
}

/** What the app's validators decided about a model call's reply (design §4.4). */
export interface CallVerdict {
  /** Which writing the call was: 0 the first, 1 the rewrite asked for after it broke a rule, … */
  rewrite: number;
  /** What the validators found in the reply, the review's judgments included; none: it passed. */
  issues: { code?: string; message: string }[];
}

/**
 * Every model call in full, one row per `usage_events` row (design §4.4, decided 2026-09-30, #58):
 * what it was sent and what it answered, for studying model behaviour across sessions while the
 * product is in its training period. The log never holds this (§4.2); the database does.
 *
 * Its own table rather than columns on `usage_events`: the two outlive different things (a call's
 * usage records what was spent and outlives its track; its content is the track's and goes with
 * it), and the content can be dropped whole when the privacy rule returns, leaving usage as it is.
 */
export const modelCalls = pgTable(
  "model_calls",
  {
    /** The call's usage row, which holds its purpose, model, tokens, status and time. */
    usageEventId: uuid("usage_event_id")
      .primaryKey()
      .references(() => usageEvents.id, { onDelete: "cascade" }),
    /** Deleted with the track or session, like everything else in them (design §4.5). */
    trackId: uuid("track_id").references(() => tracks.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").references(() => learningSessions.id, { onDelete: "cascade" }),
    /** Every message as sent, the system prompt's parts included; files named, not copied. */
    prompt: jsonb("prompt").$type<StoredJson[]>().notNull(),
    /** The response format asked for (a JSON schema for a structured record); null: text. */
    responseFormat: jsonb("response_format").$type<StoredJson>(),
    /** The tools offered, with their input schemas; null: none. */
    tools: jsonb("tools").$type<StoredJson[]>(),
    /** The call's other settings: reasoning effort, tool choice, provider options (cache hints)… */
    settings: jsonb("settings").$type<Record<string, StoredJson>>().notNull(),
    /** What the model answered; a failed call's as far as it got, null if it got nowhere. */
    reply: jsonb("reply").$type<StoredReply>(),
    /** A failed call's error: its type, message, status and the provider's response body. */
    error: jsonb("error").$type<StoredJson>(),
    /** Set by the caller once it has validated the reply; null for calls nothing validates. */
    verdict: jsonb("verdict").$type<CallVerdict>(),
  },
  (table) => [
    index("model_calls_session").on(table.sessionId),
    index("model_calls_track").on(table.trackId),
  ],
);

// ---------------------------------------------------------------------------------------------
// Tracks: one subject each, with its own term list, map, plan and fix-list (design §5)
// ---------------------------------------------------------------------------------------------

export type TermStatus = "planned" | "taught" | "confirmed" | "assumed";

export interface TrackPlan {
  /**
   * In order. `closedIn`: the session that closed the arc and set its exam (design §7.4); absent
   * while it is open.
   */
  arcs: { title: string; terms: string[]; closedIn?: string }[];
  /** Reorders and detours, in plain words. */
  notes: string;
}

export const tracks = pgTable("tracks", {
  id: id(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  /**
   * The track's short name, shown in the track list: the learner's words when they are short, else
   * named by the tutor (design §9.5), which starts from the words' first line cut short.
   */
  title: text("title").notNull(),
  /** What the learner wrote they want to learn, as typed; the session's opening turn carries it. */
  goal: text("goal").notNull(),
  /** The tutor is still naming the track; `title` is the stand-in until it is done. */
  titlePending: boolean("title_pending").notNull().default(false),
  /**
   * "What you brought": the attached files (track_files) summarized for the tutor, written once.
   * Prompts carry it in place of the files after the first session's probe and plan (design §4.5).
   * Null while the track has no files, or until it is written.
   */
  brief: text("brief"),
  /** The language lessons are taught in; null until the tutor infers it from the learner. */
  language: text("language"),
  plan: jsonb("plan").$type<TrackPlan>().notNull().default({ arcs: [], notes: "" }),
  /**
   * "Where you left off": a compact summary of the plan's notes and the last session (open
   * threads, owed work, what to re-check), written at each close. Prompts carry it in place of the
   * notes, which only the close reads (design §4.4). Null until the first is written.
   */
  leftOff: text("left_off"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * Files the learner attached when creating the track (design §4.5): a CV, a syllabus, a photo of a
 * page. Their bytes are in the file store under `storage_key`; the model reads images and PDFs as
 * they are, and text files and Word documents as `text`.
 */
export const trackFiles = pgTable(
  "track_files",
  {
    id: id(),
    trackId: uuid("track_id")
      .notNull()
      .references(() => tracks.id, { onDelete: "cascade" }),
    /** The file's name as the learner had it, without folders. */
    name: text("name").notNull(),
    kind: text("kind").$type<AttachmentKind>().notNull(),
    mediaType: text("media_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    /** A PDF's page count; null for other kinds. */
    pages: integer("pages"),
    /** Text files and Word documents: the text taken out of them. Null for images and PDFs. */
    text: text("text"),
    storageKey: text("storage_key").notNull().unique(),
    createdAt: createdAt(),
  },
  (table) => [index("track_files_track").on(table.trackId, table.createdAt)],
);

export const terms = pgTable(
  "terms",
  {
    id: id(),
    trackId: uuid("track_id")
      .notNull()
      .references(() => tracks.id, { onDelete: "cascade" }),
    term: text("term").notNull(),
    status: text("status").$type<TermStatus>().notNull(),
    /**
     * A borrowed term (design §5): held in another of the learner's tracks, this one, and so usable
     * here as held without being taught again. Its status is `confirmed`; any status recorded for it
     * in this track makes it this track's own and clears the link.
     */
    borrowedFrom: uuid("borrowed_from").references((): AnyPgColumn => terms.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex("terms_track_term").on(table.trackId, sql`lower(${table.term})`)],
);

/** Why a term has its status: every change, with the learner's words as evidence. */
export const termEvents = pgTable("term_events", {
  id: id(),
  termId: uuid("term_id")
    .notNull()
    .references(() => terms.id, { onDelete: "cascade" }),
  fromStatus: text("from_status").$type<TermStatus>(),
  toStatus: text("to_status").$type<TermStatus>().notNull(),
  evidence: text("evidence").notNull(),
  /** Where the evidence came from, e.g. "probe", "check s2", "homework". */
  source: text("source").notNull(),
  createdAt: createdAt(),
});

/** "rests on" edges: the map every structure picture is drawn from. */
export const termDependencies = pgTable(
  "term_dependencies",
  {
    termId: uuid("term_id")
      .notNull()
      .references(() => terms.id, { onDelete: "cascade" }),
    restsOnTermId: uuid("rests_on_term_id")
      .notNull()
      .references(() => terms.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.termId, table.restsOnTermId] })],
);

/** The audit's misconceptions; arc exams and the final re-test them. */
export const fixListItems = pgTable("fix_list_items", {
  id: id(),
  trackId: uuid("track_id")
    .notNull()
    .references(() => tracks.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
  status: text("status").$type<"open" | "closed">().notNull().default("open"),
  createdAt: createdAt(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
});

/**
 * The last lesson of a track imported from the learner's earlier setup (design §10), kept exactly as
 * it was and shown read-only in a sandboxed frame. One per track; older lessons are not imported.
 */
export const importedLessons = pgTable("imported_lessons", {
  trackId: uuid("track_id")
    .primaryKey()
    .references(() => tracks.id, { onDelete: "cascade" }),
  /** The lesson's title, from its <title>. */
  title: text("title").notNull(),
  /** Where it came from, e.g. the session folder's name. */
  source: text("source").notNull(),
  /** The original HTML document. Never rendered outside a sandboxed iframe. */
  html: text("html").notNull(),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------------------------
// Learning sessions (design §7).
// ---------------------------------------------------------------------------------------------

export const learningSessions = pgTable(
  "learning_sessions",
  {
    id: id(),
    trackId: uuid("track_id")
      .notNull()
      .references(() => tracks.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"normal" | "final">().notNull().default("normal"),
    /** The session state machine's state (@grounded/core). */
    state: jsonb("state").$type<SessionState>().notNull(),
    /**
     * The probe's conclusion, for the plan's prompt: where the learner's knowledge ends and what they
     * want to reach. Null until the probe finishes on its own (not when the learner skips to the plan).
     */
    probeSummary: text("probe_summary"),
    /**
     * "See where you stand" after a track's first probe (design §7.1): the verdict the learner asked
     * for, written for them from the probe's records, once. The status is null until they ask,
     * `writing` while its job runs, `written` once the verdict is stored, `failed` (with why) when
     * it couldn't be written, and they may ask again; `probe_verdict_at` is when it last changed.
     */
    probeVerdict: jsonb("probe_verdict").$type<ProbeVerdict>(),
    probeVerdictStatus: text("probe_verdict_status").$type<"writing" | "written" | "failed">(),
    probeVerdictFailure: text("probe_verdict_failure"),
    probeVerdictAt: timestamp("probe_verdict_at", { withTimezone: true }),
    /**
     * What the opening review found, for the probe's and the plan's prompts (design §7.1): whether
     * an arc exam showed its arc held, and what held and what still leaks. Null without a review, or
     * until it is done.
     */
    reviewSummary: text("review_summary"),
    /**
     * The final's teach-back (design §7.4): each place the chain of reasoning broke, as its
     * decisions marked them, in the learner's words. Empty in a normal session.
     */
    teachBackBreaks: jsonb("teach_back_breaks").$type<TeachBackBreak[]>().notNull().default([]),
    /**
     * A long session's older turns, summarized (design §4.4): prompts carry this in place of the
     * session's messages up to and including `summarized_through`, and the rest in full. Null
     * until the conversation first grows past the limit.
     */
    earlierSummary: text("earlier_summary"),
    summarizedThrough: uuid("summarized_through"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  // One open session per track: two would edit the same term list.
  (table) => [
    uniqueIndex("learning_sessions_one_open")
      .on(table.trackId)
      .where(sql`${table.closedAt} is null`),
  ],
);

/**
 * The session chat: the opening review, probe, plan, homework (and an arc exam) and recap; in the
 * final, the audit and the teach-back. The review's messages, the learner's answers included, are
 * of kind `review`, and so the audit's and the teach-back's are of theirs.
 */
export const sessionMessages = pgTable("session_messages", {
  id: id(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => learningSessions.id, { onDelete: "cascade" }),
  role: text("role").$type<"learner" | "tutor">().notNull(),
  /** The learner's words as typed; tutor messages are stored as validated blocks. */
  text: text("text"),
  blocks: jsonb("blocks").$type<Block[]>(),
  kind: text("kind")
    .$type<"review" | "message" | "plan" | "homework" | "exam" | "audit" | "teach-back" | "recap">()
    .notNull()
    .default("message"),
  /**
   * A plan's terms, as its record planned them: what its picture of what rests on what is drawn
   * around (design §9.1). Null for other messages, and for a plan whose record isn't written yet.
   */
  planTerms: jsonb("plan_terms").$type<string[]>(),
  createdAt: createdAt(),
});

export const lessons = pgTable("lessons", {
  sessionId: uuid("session_id")
    .primaryKey()
    .references(() => learningSessions.id, { onDelete: "cascade" }),
  outline: jsonb("outline").$type<StoredLessonOutline>(),
  steps: jsonb("steps").$type<LessonStep[]>().notNull().default([]),
  failedSteps: jsonb("failed_steps")
    .$type<{ stepId: string; heading: string }[]>()
    .notNull()
    .default([]),
  /** Each step's markdown as written, for prompts that need the step's text (checks, asides). */
  stepSources: jsonb("step_sources").$type<Record<string, string>>().notNull().default({}),
  /** "After the check" notes, by step id. */
  notes: jsonb("notes").$type<Record<string, string>>().notNull().default({}),
  /**
   * What the learner showed they held before the lesson taught it ("I knew this"), by the step whose
   * check it came up at: the lesson was pitched below them there (design §7.3).
   */
  alreadyHeld: jsonb("already_held").$type<Record<string, string>>().notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Each step's check thread: answers, verdicts, repairs and fresh questions. */
export const checkMessages = pgTable("check_messages", {
  id: id(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => learningSessions.id, { onDelete: "cascade" }),
  stepId: text("step_id").notNull(),
  role: text("role").$type<"learner" | "tutor">().notNull(),
  text: text("text"),
  blocks: jsonb("blocks").$type<Block[]>(),
  verdict: text("verdict").$type<"landed" | "missed">(),
  createdAt: createdAt(),
});

/**
 * A question the learner asked on a passage of the lesson, answered in the margin (design §7.5). Its
 * thread is in aside_messages.
 */
export const asides = pgTable(
  "asides",
  {
    id: id(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => learningSessions.id, { onDelete: "cascade" }),
    /** The step the passage is in. */
    stepId: text("step_id").notNull(),
    /** The passage: its block, the quote and the text around it. */
    anchor: jsonb("anchor").$type<AsideAnchor>().notNull(),
    /** A tangent the tutor offered to save for a future session, in a few words; null if none. */
    tangent: text("tangent"),
    /** When the learner saved the tangent (it is then in the plan's notes); null until they do. */
    savedAt: timestamp("saved_at", { withTimezone: true }),
    /**
     * Asked or followed up on after its session closed: the later session whose opening review
     * takes it up (design §7.1), claimed as that session starts; null until one does.
     */
    takenUpIn: uuid("taken_up_in").references(() => learningSessions.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (table) => [index("asides_session").on(table.sessionId, table.createdAt)],
);

/**
 * What the tutor found with the provider's web search (design §4.4): before a track's first plan,
 * and before a lesson's outline where it wasn't sure of a fact. Notes for the model, with sources.
 */
export const researchNotes = pgTable(
  "research_notes",
  {
    id: id(),
    trackId: uuid("track_id")
      .notNull()
      .references(() => tracks.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => learningSessions.id, { onDelete: "cascade" }),
    /** What it was for: the plan's scoping of the field, or a lesson's facts. */
    kind: text("kind").$type<"plan" | "lesson">().notNull(),
    notes: text("notes").notNull(),
    /** The searches the notes rest on, as the provider reported their queries. */
    searches: jsonb("searches").$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
  },
  (table) => [index("research_notes_session").on(table.sessionId, table.createdAt)],
);

/** An aside's thread: the learner's question, the answer, and follow-ups. */
export const asideMessages = pgTable(
  "aside_messages",
  {
    id: id(),
    asideId: uuid("aside_id")
      .notNull()
      .references(() => asides.id, { onDelete: "cascade" }),
    role: text("role").$type<"learner" | "tutor">().notNull(),
    /** The learner's words as typed; the tutor's markdown as written. */
    text: text("text").notNull(),
    /** The tutor's answer as validated blocks; null for the learner's messages. */
    blocks: jsonb("blocks").$type<Block[]>(),
    createdAt: createdAt(),
  },
  (table) => [index("aside_messages_aside").on(table.asideId, table.createdAt)],
);

// ---------------------------------------------------------------------------------------------
// Homework and arc exams (design §7.4)
// ---------------------------------------------------------------------------------------------

/**
 * Homework, or an arc exam: what the session that assigned it asks, in typed tasks, and what a good
 * answer demonstrates. It outlives its session: the learner hands it in whenever they have room.
 * Its events go on the log of the session that assigned it.
 */
export const assignments = pgTable(
  "assignments",
  {
    id: id(),
    trackId: uuid("track_id")
      .notNull()
      .references(() => tracks.id, { onDelete: "cascade" }),
    /** The session that assigned it. */
    sessionId: uuid("session_id")
      .notNull()
      .references(() => learningSessions.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").$type<AssignmentKind>().notNull(),
    /** A few words naming it, for the track list. */
    title: text("title").notNull(),
    tasks: jsonb("tasks").$type<AssignmentTask[]>().notNull(),
    /** "What a good answer demonstrates" (method.md, "Homework"). */
    checklist: jsonb("checklist").$type<ChecklistItem[]>().notNull(),
    /** The chat message it was written as. */
    messageId: uuid("message_id").notNull(),
    /** When the learner handed it in; null while it is open. */
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    /** "Later" with a snooze (design §7.4): when it is due again; null when it wasn't put off. */
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    /**
     * The later homework it was folded into (method.md, "Homework"): it is closed then, never
     * handed in, and that one covers its ground too.
     */
    subsumedBy: uuid("subsumed_by").references((): AnyPgColumn => assignments.id, {
      onDelete: "set null",
    }),
    /**
     * An arc exam: when starting a later session warned that it is still open (design §7.4), the
     * one warning it gets; null until then.
     */
    warnedAt: timestamp("warned_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("assignments_track").on(table.trackId, table.createdAt),
    uniqueIndex("assignments_message").on(table.messageId),
  ],
);

/** The learner's answers to an assignment, saved as they write, until they hand it in. */
export const submissions = pgTable("submissions", {
  assignmentId: uuid("assignment_id")
    .primaryKey()
    .references(() => assignments.id, { onDelete: "cascade" }),
  answers: jsonb("answers").$type<Answers>().notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * Pictures the learner put in their answers (a photo of a notebook page). Their bytes are in the
 * file store under `storage_key`; the answer's markdown links them by id.
 */
export const answerFiles = pgTable(
  "answer_files",
  {
    id: id(),
    assignmentId: uuid("assignment_id")
      .notNull()
      .references(() => assignments.id, { onDelete: "cascade" }),
    mediaType: text("media_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    storageKey: text("storage_key").notNull().unique(),
    createdAt: createdAt(),
  },
  (table) => [index("answer_files_assignment").on(table.assignmentId)],
);

/**
 * The review of a handed-in assignment (design §7.4): one per assignment, started when it is handed
 * in. Its comments are in `review_comments`; the checklist's marks are here.
 */
export const reviews = pgTable("reviews", {
  id: id(),
  assignmentId: uuid("assignment_id")
    .notNull()
    .unique()
    .references(() => assignments.id, { onDelete: "cascade" }),
  /** reviewing: its job is on it · done · failed: it can be started again. */
  status: text("status").$type<"reviewing" | "done" | "failed">().notNull().default("reviewing"),
  /** Each item of "what a good answer demonstrates", marked held, leaked or missing. */
  checklist: jsonb("checklist").$type<ChecklistMark[]>().notNull().default([]),
  /** Why a failed review failed, for the learner (their key, their provider); null otherwise. */
  failure: text("failure"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  /**
   * The later session whose opening review takes it up (design §7.1), claimed as that session
   * starts; null until one does. Each review is taken up once.
   */
  takenUpIn: uuid("taken_up_in").references(() => learningSessions.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * A comment in the margin of a reviewed answer: where the learner's model leaked, anchored to the
 * part of the answer it is about. Its thread (the comment, then the learner's replies and the
 * tutor's answers) is in `review_messages`. Until it is resolved it is an open leak, which the next
 * session's review carries on (design §7.4).
 */
export const reviewComments = pgTable(
  "review_comments",
  {
    id: id(),
    reviewId: uuid("review_id")
      .notNull()
      .references(() => reviews.id, { onDelete: "cascade" }),
    /** Its place among the review's comments, in the order of the answer. */
    position: integer("position").notNull(),
    anchor: jsonb("anchor").$type<ReviewAnchor>().notNull(),
    /** The checklist items it bears on (c1, c2…). */
    items: jsonb("items").$type<string[]>().notNull().default([]),
    /** When the leak was resolved; null while it is open. */
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    /** The later session whose review resolved it; null while open, or when its card did. */
    resolvedInSession: uuid("resolved_in_session").references(() => learningSessions.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
  },
  (table) => [index("review_comments_review").on(table.reviewId, table.position)],
);

/** A comment's thread: the tutor's comment first, then the learner's replies and the answers. */
export const reviewMessages = pgTable(
  "review_messages",
  {
    id: id(),
    commentId: uuid("comment_id")
      .notNull()
      .references(() => reviewComments.id, { onDelete: "cascade" }),
    role: text("role").$type<"learner" | "tutor">().notNull(),
    /** The learner's words as typed; the tutor's markdown as written. */
    text: text("text").notNull(),
    /** The tutor's words as validated blocks; null for the learner's. */
    blocks: jsonb("blocks").$type<Block[]>(),
    createdAt: createdAt(),
  },
  (table) => [index("review_messages_comment").on(table.commentId, table.createdAt)],
);

/** An ordered log of everything that happened in a session; SSE replays it from any point. */
export const sessionEvents = pgTable(
  "session_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => learningSessions.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    data: jsonb("data").$type<unknown>().notNull(),
    createdAt: createdAt(),
  },
  (table) => [index("session_events_session").on(table.sessionId, table.id)],
);

// ---------------------------------------------------------------------------------------------
// The learner's teaching notes (design §8): how this person learns, across their tracks.
// ---------------------------------------------------------------------------------------------

/** What a teaching note rests on: a session, and what in it showed the pattern. */
export interface NoteEvidence {
  sessionId: string;
  /** In plain words, e.g. "the check on step 2 landed only after the worked example". */
  what: string;
}

/**
 * A teaching note: guidance about teaching this learner, never a judgment of ability. The profile
 * job revises, removes and adds them at a session close; the learner reads and edits them.
 */
export const learnerProfileNotes = pgTable(
  "learner_profile_notes",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    /** The sessions it rests on; none for a note the learner wrote themselves. */
    evidence: jsonb("evidence").$type<NoteEvidence[]>().notNull().default([]),
    createdAt: createdAt(),
    /** When its text last changed, by a refresh or by the learner. */
    revisedAt: timestamp("revised_at", { withTimezone: true }).notNull().defaultNow(),
    /** The learner wrote it, or edited it since a refresh last did: a refresh keeps its sense. */
    byLearner: boolean("by_learner").notNull().default(false),
  },
  (table) => [index("learner_profile_notes_user").on(table.userId, table.createdAt)],
);

/**
 * Each refresh of a learner's teaching notes, whether it changed them or not: the next is due some
 * sessions after the last (design §8), and it reads the evidence since.
 */
export const profileRefreshes = pgTable(
  "profile_refreshes",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The session whose close it ran at. */
    sessionId: uuid("session_id").references(() => learningSessions.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (table) => [index("profile_refreshes_user").on(table.userId, table.createdAt)],
);
