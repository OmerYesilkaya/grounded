/*
 * What the API tells the learner (design §9.3): its refusals, the failures it stores in their
 * place, and what a job is doing right now. The API sends each as a code with its values, never
 * in words; the web words it in the app's language (`apps/web/src/i18n/messages/notices.ts`), so
 * what was stored reads in whatever language the page is in when it is read. A code added here
 * without words in every language fails the web's typecheck.
 */

/** A model call's failure the learner can act on (design §4.4); the rest is "unknown". */
export type ProviderFailureKind =
  "invalid-key" | "no-credit" | "rate-limited" | "unreachable" | "timeout" | "refused" | "unknown";

/** Why a job's model call failed: the learner's provider (named as the learner knows it), or us. */
export type Cause =
  | { code: "provider-failed"; kind: ProviderFailureKind; provider: string }
  | { code: "no-credential" }
  /** The tutor's reply came back empty, however often it was asked. */
  | { code: "empty-reply" }
  /** A problem on our side, or a job that died and was found by recovery. */
  | { code: "our-side" }
  | { code: "interrupted" };

/** What an answer field is, for a message naming it: a form's field, or a derivation's step. */
export type FieldRef =
  | { field: "prediction" | "observed" | "reconcile" | "work" | "surprised" | "text" }
  | { field: "step" | "because"; step: number };

/** What a running job is doing, for the session's activity line (design §9.3). */
export type ActivityNotice =
  | { code: "thinking"; again: boolean }
  | { code: "rewriting-message" }
  | { code: "reading-left-off" }
  | { code: "reading-brought" }
  | { code: "noting-answers" }
  | { code: "taking-stock" }
  | { code: "researching" }
  | { code: "searching-web"; query: string | null }
  | { code: "checking-facts" }
  | { code: "outlining" }
  | { code: "writing-step"; step: number; of: number; again: boolean }
  | { code: "checking-answer" }
  | { code: "writing-fresh-question" }
  | { code: "noting-good-answer" }
  | { code: "updating-terms" }
  | { code: "noting-left-off" }
  | { code: "recording-plan" }
  | { code: "revising-plan" }
  | { code: "condensing" }
  | { code: "reviewing"; exam: boolean }
  | { code: "finding-where-knowledge-ends" }
  | { code: "finding-media"; kind: "image" | "audio"; query: string };

/** A request the API turned down, and why, in the learner's terms. */
export type RefusalNotice =
  // Anywhere
  | { code: "not-found" }
  | { code: "server-error" }
  // Signing in and the key (design §4.3)
  | { code: "sign-in-first" }
  | { code: "enter-email-and-password" }
  | { code: "email-or-password-wrong" }
  | { code: "too-many-attempts" }
  | { code: "password-length"; min: number; max: number }
  | { code: "current-password-wrong" }
  | { code: "credential-incomplete" }
  | { code: "model-unavailable" }
  // Tracks and what they bring (design §4.5)
  | { code: "goal-required"; max: number }
  | { code: "files-too-large" }
  // Tracks taught from a source (design §4.6)
  | { code: "source-required" }
  | { code: "source-kind"; name: string }
  | { code: "source-not-ready" }
  | { code: "source-not-awaiting" }
  | { code: "attachment-kind"; name: string }
  | { code: "attachment-empty"; name: string }
  | { code: "attachment-too-large"; name: string; megabytes: number }
  | { code: "attachments-too-many"; max: number }
  | { code: "attachments-too-large"; megabytes: number }
  | { code: "attachment-not-what-it-says"; name: string }
  | { code: "attachment-password"; name: string }
  | { code: "attachment-unreadable"; name: string; as: "pdf" | "docx" }
  | { code: "attachment-not-utf8"; name: string }
  | { code: "attachment-no-text"; name: string }
  | { code: "attachment-too-long"; name: string; characters: number; max: number }
  | { code: "attachments-pdf-pages"; pages: number; max: number }
  // Sessions and the chat
  | { code: "session-open" }
  | { code: "not-a-session-kind" }
  | { code: "final-after-exam" }
  | { code: "final-done" }
  | { code: "final-after-plan" }
  | { code: "exam-open"; title: string }
  | { code: "write-message" }
  | { code: "nothing-to-retry" }
  | { code: "tutor-on-it" }
  | { code: "tutor-busy" }
  | { code: "nothing-to-show" }
  | { code: "no-outline" }
  // The session's phases (the state machine, design §7.1)
  | { code: "session-closed" }
  | { code: "questions-in-margin" }
  | { code: "not-taking-messages" }
  | { code: "no-review" }
  | { code: "no-audit" }
  | { code: "no-teach-back" }
  | { code: "final-has-no-plan" }
  | { code: "review-before-probe" }
  | { code: "probe-over" }
  | { code: "not-planning" }
  | { code: "no-plan-to-approve" }
  | { code: "plan-not-approved" }
  | { code: "no-lesson-being-written" }
  | { code: "only-failed-lesson" }
  | { code: "step-not-in-lesson" }
  | { code: "step-paused" }
  | { code: "step-not-checked" }
  | { code: "pause-or-continue-first" }
  | { code: "pressed-already" }
  | { code: "pause-not-offered" }
  | { code: "continue-not-offered" }
  | { code: "nothing-paused" }
  | { code: "no-lesson-to-finish" }
  | { code: "checks-open" }
  | { code: "homework-after-checks" }
  | { code: "no-homework-yet" }
  | { code: "no-homework-in-review" }
  | { code: "recap-after-teach-back" }
  | { code: "recap-after-homework" }
  // Checks and asides (design §7.3, §7.5)
  | { code: "write-answer-or-dont-know" }
  | { code: "step-being-written" }
  | { code: "answer-being-checked" }
  | { code: "write-question" }
  | { code: "passage-not-readable" }
  | { code: "question-being-answered" }
  | { code: "nothing-to-save" }
  // Homework and exams (design §7.4)
  | { code: "write-answer" }
  | { code: "task-not-in-assignment" }
  | { code: "no-prediction-to-lock" }
  | { code: "write-prediction-first" }
  | { code: "prediction-locked" }
  | { code: "lock-prediction-first"; part: string | null }
  | ({ code: "answer-missing"; part: string | null } & FieldRef)
  | { code: "no-such-field"; key: string }
  | { code: "answer-too-long"; max: number }
  | { code: "picture-too-large"; megabytes: number }
  | { code: "choose-picture" }
  | { code: "pictures-only" }
  | { code: "pictures-too-many"; max: number }
  | { code: "choose-when" }
  | { code: "tonight-over" }
  | { code: "hand-in-first" }
  | { code: "being-reviewed" }
  | { code: "write-reply" }
  | { code: "found-already" }
  | { code: "reply-being-answered" }
  | { code: "handed-in" }
  | { code: "folded-into-later" }
  | { code: "homework-closed" }
  // Teaching notes (design §8)
  | { code: "write-note" }
  | { code: "notes-limit"; max: number };

/** A failure the app says in place of what the learner waited for (a job's `error` event). */
export type FailureNotice =
  | Cause
  | { code: "outline-failed" }
  | { code: "plan-failed" }
  | { code: "lesson-interrupted" }
  /** Said in a thread in place of the tutor's answer: the learner can ask, answer or reply again. */
  | { code: "thread-failed"; thread: "check" | "aside" | "reply"; cause: Cause | null };

/** Why reading a track's source stopped (design §4.6), shown on the track. */
export type SourceFailure =
  /** Pages need the model to read them, and the learner's model doesn't read PDFs. */
  | { code: "source-needs-vision"; pages: number; model: string }
  /** A file turned out not to be readable once opened (a broken EPUB, a PDF that won't parse). */
  | { code: "source-unreadable"; name: string }
  /** The sources hold more text than a track can (`SOURCE_LIMITS.characters`). */
  | { code: "source-too-long"; characters: number; max: number }
  /** A model call failed while reading; the learner can try again. */
  | { code: "source-reading-stopped"; cause: Cause | null };

export type Notice = RefusalNotice | FailureNotice | ActivityNotice | SourceFailure;
export type NoticeCode = Notice["code"];

/** The codes of refusals that take no values: "not-found". */
export type BareRefusalCode = RefusalNotice extends infer N
  ? N extends { code: infer C }
    ? Exclude<keyof N, "code"> extends never
      ? C
      : never
    : never
  : never;

/** A refusal that takes no values, by its code. */
export const bare = (code: BareRefusalCode): RefusalNotice => ({ code }) as RefusalNotice;

/** A refusal's body (design §9.3): what the web words, and whatever goes with it. */
export const refusal = (notice: RefusalNotice | Cause, extra: Record<string, unknown> = {}) => ({
  error: notice,
  ...extra,
});

/** Whether a value is a notice (a code with its values), as against words stored before them. */
export const isNotice = (value: unknown): value is Notice =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { code?: unknown }).code === "string";
