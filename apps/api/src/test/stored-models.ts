import type { KeyVault } from "@grounded/crypto";
import { credentials, type Db } from "@grounded/db";
import { createModelCaller, type ModelAccess } from "../engine/model-call.js";

/**
 * Scripted models called through the real model caller, so every call is recorded and stored
 * (`model_calls`) as in production. A learner without a key gets one on their first call. `deps`
 * is read at call time: the harness that provides it is built with this access.
 */
export function throughTheCaller(scripted: ModelAccess, deps: () => { db: Db; vault: KeyVault }) {
  const access: ModelAccess = {
    async model(request) {
      const { db, vault } = deps();
      await db
        .insert(credentials)
        .values({
          userId: request.userId,
          provider: "openai",
          model: "gpt-6-luna",
          sealedKey: vault.seal("sk-test-0000", request.userId),
          keyHint: "0000",
        })
        .onConflictDoNothing();
      const model = await scripted.model(request);
      return createModelCaller({ db, vault, createLanguageModel: () => model }).model(request);
    },
    searchTool: (userId) => scripted.searchTool(userId),
  };
  return access;
}
