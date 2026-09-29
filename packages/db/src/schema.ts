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
  AsideAnchor,
  AttachmentKind,
  SessionState,
  StoredLessonOutline,
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
// Auth (the shape Better Auth expects; ids are UUIDv7 through its generateId hook)
// ---------------------------------------------------------------------------------------------

export const users = pgTable("users", {
  id: id(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sessions = pgTable("sessions", {
  id: id(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const accounts = pgTable("accounts", {
  id: id(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  password: text("password"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const verifications = pgTable("verifications", {
  id: id(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Who may sign in. Managed with `pnpm invite` / `pnpm revoke`. Emails are stored lowercased. */
export const allowlist = pgTable("allowlist", {
  email: text("email").primaryKey(),
  invitedAt: timestamp("invited_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------------------------
// Credentials and usage
// ---------------------------------------------------------------------------------------------

export type ProviderId = "anthropic" | "openai" | "google";
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

// ---------------------------------------------------------------------------------------------
// Tracks: one subject each, with its own term list, map, plan and fix-list (design §5)
// ---------------------------------------------------------------------------------------------

export type TermStatus = "planned" | "taught" | "confirmed" | "assumed";

export interface TrackPlan {
  arcs: { title: string; terms: string[] }[];
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
// Learning sessions (design §7). "sessions" is Better Auth's table.
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

/** The session chat: probe, plan, homework and recap. */
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
    .$type<"message" | "plan" | "homework" | "recap">()
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
