import {
  createDemoModels,
  createEmbedded,
  createFreshDatabase,
  createModelCaller,
  invite,
} from "@grounded/api/embedded";
import type { Method } from "@grounded/core";
import { learningSessions, type Db } from "@grounded/db";
import { createLanguageModel, type ProviderId } from "@grounded/providers";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { DriveError, driveSession } from "./drive.js";
import { judge, type Judgement } from "./judge.js";
import type { Learner } from "./learner.js";
import { modelLearner } from "./learner.js";
import { metricsOf, type Metrics } from "./metrics.js";
import type { Persona } from "./persona.js";
import { readRecord } from "./record.js";
import { transcriptOf } from "./transcript.js";

/** The tutor being evaluated: a model on the list with a key, or the canned demo models. */
export type Candidate =
  { kind: "model"; provider: ProviderId; model: string; apiKey: string } | { kind: "demo" };

export interface RunOptions {
  persona: Persona;
  candidate: Candidate;
  /** The method under test and a label for it (the repo's method.md when absent). */
  method?: { method: Method; label: string };
  /** Plays the persona: a model, or a scripted learner (tests). */
  learner: LanguageModelV4 | Learner;
  /** Scores the transcript; no judgement without it. */
  judgeModel?: LanguageModelV4;
  /** The Postgres server the run's own database is made on (its name is the prefix). */
  serverUrl: string;
  /** Keep the run's database afterwards, to look at it. */
  keepDatabase?: boolean;
  onProgress?: (line: string) => void;
  turnTimeoutMs?: number;
}

export interface RunResult {
  persona: string;
  model: string;
  method: string;
  startedAt: string;
  wallSeconds: number;
  /** Why the session didn't reach its close, if it didn't. */
  error: string | null;
  metrics: Metrics | null;
  judgement: Judgement | null;
  /** Why the judge couldn't score the run, if it couldn't; the counts and transcript still stand. */
  judgeError: string | null;
  transcript: string;
  database: string | null;
}

let runs = 0;

/** One eval session: a fresh backend and database, the persona driven through it, then the scores. */
export async function runEval(options: RunOptions): Promise<RunResult> {
  const startedAt = new Date();
  const { persona, candidate } = options;
  const database = await createFreshDatabase(
    options.serverUrl,
    `eval_${String(process.pid)}_${String((runs += 1))}`,
  );
  const backend = createEmbedded({
    databaseUrl: database.url,
    models:
      candidate.kind === "demo"
        ? createDemoModels()
        : ({ db, vault }) => createModelCaller({ db, vault, createLanguageModel }),
    ...(options.method ? { method: options.method.method } : {}),
  });
  const result: RunResult = {
    persona: persona.id,
    model: candidate.kind === "demo" ? "demo" : candidate.model,
    method: options.method?.label ?? "method.md",
    startedAt: startedAt.toISOString(),
    wallSeconds: 0,
    error: null,
    metrics: null,
    judgement: null,
    judgeError: null,
    transcript: "",
    database: options.keepDatabase ? database.url : null,
  };
  try {
    const email = `learner-${persona.id}@eval.grounded.test`;
    await invite(backend.db, email);
    const cookie = await backend.signIn(email);
    const key = await backend.request("/api/credentials", {
      method: "PUT",
      cookie,
      body: JSON.stringify(
        candidate.kind === "demo"
          ? { provider: "anthropic", model: "claude-opus-5-5", apiKey: "demo-key-unused" }
          : { provider: candidate.provider, model: candidate.model, apiKey: candidate.apiKey },
      ),
    });
    if (!key.ok) throw new DriveError(`storing the key failed: ${await key.text()}`);

    const learner =
      "reply" in options.learner ? options.learner : modelLearner(options.learner, persona);
    let sessionId: string | null = null;
    try {
      sessionId = await driveSession({
        backend,
        cookie,
        goal: persona.goal,
        learner,
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
        ...(options.turnTimeoutMs ? { turnTimeoutMs: options.turnTimeoutMs } : {}),
      });
    } catch (error) {
      if (!(error instanceof DriveError)) throw error;
      result.error = error.message;
    }
    sessionId ??= await onlySession(backend);
    if (sessionId) {
      const record = await readRecord(backend.db, sessionId);
      result.metrics = metricsOf(record);
      result.transcript = transcriptOf(record);
      if (options.judgeModel) {
        try {
          result.judgement = await judge(options.judgeModel, persona, result.transcript);
        } catch (error) {
          result.judgeError = error instanceof Error ? error.message : String(error);
        }
      }
    }
  } finally {
    result.wallSeconds = Math.round((Date.now() - startedAt.getTime()) / 1000);
    await backend.stop();
    if (options.keepDatabase) await database.keep();
    else await database.drop();
  }
  return result;
}

/** The run's session, when the drive failed before returning it (the run's database has one). */
async function onlySession(backend: { db: Db }): Promise<string | null> {
  const [session] = await backend.db.select({ id: learningSessions.id }).from(learningSessions);
  return session?.id ?? null;
}
