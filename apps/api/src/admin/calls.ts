import type { CallDetail } from "@grounded/core/admin";
import { eq, modelCalls, usageEvents, users, type Db } from "@grounded/db";
import { estimateCost } from "@grounded/providers";

export async function callDetail(db: Db, id: string): Promise<CallDetail | null> {
  const [row] = await db
    .select({ usage: usageEvents, content: modelCalls, learner: users.learnerNumber })
    .from(usageEvents)
    .innerJoin(users, eq(users.id, usageEvents.userId))
    .leftJoin(modelCalls, eq(modelCalls.usageEventId, usageEvents.id))
    .where(eq(usageEvents.id, id));
  if (!row) return null;
  const { usage: u, content: c } = row;
  return {
    id: u.id,
    sessionId: u.sessionId,
    trackId: u.trackId,
    learner: row.learner,
    at: u.createdAt.toISOString(),
    purpose: u.purpose,
    provider: u.provider,
    model: u.model,
    status: u.status,
    errorKind: u.errorKind,
    durationMs: u.durationMs,
    tokens: {
      input: u.inputTokens,
      cachedInput: u.cachedInputTokens,
      cacheWrite: u.cacheWriteTokens,
      output: u.outputTokens,
    },
    costUsd: estimateCost(u.model, u),
    methodVersion: u.methodVersion,
    release: u.release,
    content: c
      ? {
          prompt: c.prompt,
          responseFormat: c.responseFormat,
          tools: c.tools,
          settings: c.settings,
          reply: c.reply,
          error: c.error,
          verdict: c.verdict,
        }
      : null,
  };
}
