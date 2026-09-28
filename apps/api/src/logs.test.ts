import { beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { invite } from "./allowlist.js";
import { captureLogs, type LogFields } from "./log.js";
import { createFlows, FIRST_QUESTION } from "./test/flows.js";
import { createTestHarness } from "./test/harness.js";
import { scriptedModels } from "./test/scripted-models.js";

const models = scriptedModels();
const t = createTestHarness({ models: models.access });
const { learner } = createFlows(t, models);

beforeEach(() => {
  models.reset();
});

/** Everything logged from here to the end of the test, at every level. */
function logs() {
  const captured = captureLogs("trace");
  onTestFinished(captured.restore);
  return captured;
}

const withMsg = (lines: LogFields[], message: string) => lines.filter((l) => l.message === message);

describe("request lines", () => {
  it("give the method, route, status and time, with the reason for a refusal", async () => {
    const captured = logs();
    await invite(t.db, "ada@example.com");
    const cookie = await t.signIn("ada@example.com");
    const response = await t.request("/api/sessions/not-a-session", { cookie });
    expect(response.status).toBe(404);

    expect(withMsg(captured.lines, "request refused")).toEqual([
      expect.objectContaining({
        level: "warn",
        requestId: response.headers.get("x-request-id"),
        userId: expect.any(String) as string,
        method: "GET",
        route: "/api/sessions/:id",
        path: "/api/sessions/not-a-session",
        status: 404,
        reason: "Not found.",
        durationMs: expect.any(Number) as number,
      }),
    ]);
  });

  it("never give the query string: the magic link's token travels in it", async () => {
    const captured = logs();
    await invite(t.db, "ada@example.com");
    await t.signIn("ada@example.com");
    const token = new URL(t.sent.at(-1)?.url ?? "").searchParams.get("token");

    expect(withMsg(captured.lines, "request").map((l) => l.path)).toContain(
      "/api/auth/magic-link/verify",
    );
    expect(token).toBeTruthy();
    expect(captured.text()).not.toContain(token);
  });

  it("carry the request id into the jobs it queues", async () => {
    const captured = logs();
    const { cookie, trackId } = await learner();
    models.script("probe", { text: FIRST_QUESTION });
    const started = await t.request(`/api/tracks/${trackId}/sessions`, { method: "POST", cookie });
    const { id: sessionId } = (await started.json()) as { id: string };
    await t.waitFor(() =>
      Promise.resolve(
        withMsg(captured.lines, "job finished").some((l) => l.sessionId === sessionId),
      ),
    );

    const requestId = started.headers.get("x-request-id");
    const job = captured.lines.filter((l) => l.task === "probe-turn");
    expect(job.map((l) => l.message)).toEqual(
      expect.arrayContaining(["job started", "job finished"]),
    );
    for (const line of job)
      expect(line).toMatchObject({ requestId, sessionId, jobId: expect.any(String) as string });
  });
});
