import { ATTACHMENT_LIMITS, initialSession } from "@grounded/core";
import { eq, learningSessions, trackFiles, tracks } from "@grounded/db";
import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it } from "vitest";
import { invite } from "./allowlist.js";
import { readAttachments } from "./files/attachments.js";
import { createMemoryFileStore } from "./files/store.js";
import { createTrack } from "./files/track-files.js";
import { createTestHarness } from "./test/harness.js";
import { scriptedModel, scriptedModels } from "./test/scripted-models.js";
import { DOCX, PNG, pdf, text } from "./test/files.js";
import {
  createFlows,
  FIRST_QUESTION,
  PLAN_TEXT,
  planAttempt,
  finishProbe,
  storedMessages,
} from "./test/flows.js";

const models = scriptedModels();
const t = createTestHarness({ models: models.access });

beforeEach(() => {
  models.reset();
});

const { activities, until } = createFlows(t, models);

const GOAL =
  "I want to learn how to pass backend and fullstack interviews.\n\nI've built APIs for a few years but never studied the theory.";

interface TrackRow {
  id: string;
  title: string;
  naming: boolean;
  files: { id: string; name: string; kind: string; sizeBytes: number }[];
}

const signedIn = async () => {
  await invite(t.db, "ada@example.com");
  return t.signIn("ada@example.com");
};

const create = async (cookie: string, goal: string) => {
  const response = await t.request("/api/tracks", {
    method: "POST",
    cookie,
    body: JSON.stringify({ goal }),
  });
  return { status: response.status, body: (await response.json()) as TrackRow };
};

const listed = async (cookie: string, id: string) => {
  const list = (await (await t.request("/api/tracks", { cookie })).json()) as TrackRow[];
  return list.find((row) => row.id === id);
};

describe("creating a track", () => {
  it("takes short words as the name, with nothing to name", async () => {
    const cookie = await signedIn();
    const { status, body } = await create(cookie, "  How software works ");
    expect(status).toBe(201);
    expect(body).toMatchObject({ title: "How software works", naming: false });
    const [row] = await t.db.select().from(tracks).where(eq(tracks.id, body.id));
    expect(row?.goal).toBe("How software works");
  });

  it("has the tutor name a track whose words run long, the first line standing in", async () => {
    const cookie = await signedIn();
    models.script("track-name", { text: JSON.stringify({ name: '"Backend interviews."' }) });
    const { body } = await create(cookie, GOAL);
    expect(body).toMatchObject({
      title: "I want to learn how to pass backend and fullstack…",
      naming: true,
    });

    await t.waitFor(async () => (await listed(cookie, body.id))?.naming === false);
    expect(await listed(cookie, body.id)).toMatchObject({ title: "Backend interviews" });
    const call = models.used.find((u) => u.purpose === "track-name")?.model.doGenerateCalls[0];
    expect(JSON.stringify(call?.prompt)).toContain("never studied the theory");
  });

  it("keeps the stand-in when naming fails, and stops naming", async () => {
    const cookie = await signedIn();
    // No scripted model for "track-name": the call fails.
    const { body } = await create(cookie, GOAL);
    await t.waitFor(async () => (await listed(cookie, body.id))?.naming === false);
    expect(await listed(cookie, body.id)).toMatchObject({
      title: "I want to learn how to pass backend and fullstack…",
    });
  });

  it("refuses empty words, and words past the limit", async () => {
    const cookie = await signedIn();
    expect((await create(cookie, "   ")).status).toBe(400);
    expect((await create(cookie, "x".repeat(4001))).status).toBe(400);
  });

  it("opens the first session with the learner's words as typed", async () => {
    const cookie = await signedIn();
    models.script("track-name", { text: JSON.stringify({ name: "Backend interviews" }) });
    const { body } = await create(cookie, GOAL);
    models.script("probe", { text: FIRST_QUESTION });
    await t.request(`/api/tracks/${body.id}/sessions`, { method: "POST", cookie });
    await t.waitFor(() => Promise.resolve(models.used.some((u) => u.purpose === "probe")));
    const probe = models.used.find((u) => u.purpose === "probe")?.model;
    await t.waitFor(() => Promise.resolve((probe?.doStreamCalls.length ?? 0) > 0));
    const opening = probe?.doStreamCalls[0]?.prompt.find((m) => m.role === "user");
    expect(JSON.stringify(opening?.content)).toContain("never studied the theory");
  });
});

describe("creating a track with files", () => {
  const form = (goal: string, attached: { name: string; bytes: Uint8Array; type?: string }[]) => {
    const body = new FormData();
    body.set("goal", goal);
    for (const f of attached)
      body.append("files", new File([f.bytes.slice()], f.name, { type: f.type ?? "" }));
    return body;
  };
  const upload = (cookie: string, body: FormData) =>
    t.request("/api/tracks", { method: "POST", cookie, body });

  it("keeps the files with the track, lists them, and gives them back to their owner", async () => {
    const cookie = await signedIn();
    const cv = await pdf(2);
    const response = await upload(
      cookie,
      form("Everything my CV says I know", [
        { name: "cv.pdf", bytes: cv },
        { name: "notes.docx", bytes: DOCX },
        { name: "whiteboard.png", bytes: PNG },
      ]),
    );
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as TrackRow;

    const rows = await t.db.select().from(trackFiles).where(eq(trackFiles.trackId, id));
    expect(rows.map((r) => [r.name, r.kind, r.pages, r.sizeBytes])).toEqual([
      ["cv.pdf", "pdf", 2, cv.length],
      ["notes.docx", "docx", null, DOCX.length],
      ["whiteboard.png", "image", null, PNG.length],
    ]);
    expect(rows[1]?.text).toContain("Redis caching");
    expect(await t.files.get(rows[0]?.storageKey ?? "")).toEqual(cv);

    const track = await listed(cookie, id);
    expect(track?.files.map((f) => f.name)).toEqual(["cv.pdf", "notes.docx", "whiteboard.png"]);

    const file = track?.files[0];
    const download = await t.request(`/api/tracks/${id}/files/${file?.id ?? ""}`, { cookie });
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/pdf");
    expect(download.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''cv.pdf");
    expect(download.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(cv);

    await invite(t.db, "eve@example.com");
    const eve = await t.signIn("eve@example.com");
    const theirs = await t.request(`/api/tracks/${id}/files/${file?.id ?? ""}`, { cookie: eve });
    expect(theirs.status).toBe(404);
  });

  it("refuses a file that isn't what it says, and keeps nothing", async () => {
    const cookie = await signedIn();
    const before = t.files.keys().length;
    const response = await upload(
      cookie,
      form("Everything my CV says I know", [
        { name: "cv.pdf", bytes: await pdf(1) },
        { name: "photo.png", bytes: text("not a picture") },
      ]),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "photo.png doesn't look like the file its name says it is.",
    });
    expect(t.files.keys()).toHaveLength(before);
    expect(await t.db.select().from(tracks)).toHaveLength(0);
  });

  it("refuses files too large together before reading them", async () => {
    const cookie = await signedIn();
    const big = new Uint8Array(ATTACHMENT_LIMITS.totalBytes + 2 * 1024 * 1024);
    const response = await upload(cookie, form("Photos", [{ name: "a.png", bytes: big }]));
    expect(response.status).toBe(413);
  });

  it("still needs the learner's words", async () => {
    const cookie = await signedIn();
    const response = await upload(cookie, form("  ", [{ name: "cv.pdf", bytes: await pdf(1) }]));
    expect(response.status).toBe(400);
  });

  it("removes stored bytes again when the track can't be created", async () => {
    const store = createMemoryFileStore();
    const read = await readAttachments([{ name: "cv.pdf", bytes: await pdf(1) }]);
    if (!read.ok) throw new Error(read.error);
    // No such learner: the insert fails after the bytes are stored.
    await expect(
      createTrack(
        t.db,
        store,
        { userId: "01920000-0000-7000-8000-000000000000", goal: "x", title: "x" },
        read.attachments,
      ),
    ).rejects.toThrow();
    expect(store.keys()).toEqual([]);
  });
});

describe("the tutor reading what the learner brought", () => {
  const BRIEF =
    "A CV: four years of Node.js APIs on Postgres; Redis caching. Wants backend interviews.";

  /**
   * A track with a PDF and a Word document, once the job that summarizes them has run: writing
   * `brief`, or failing when it is null.
   */
  const trackWithFiles = async (brief: string | null = BRIEF) => {
    const cookie = await signedIn();
    const summarizer = brief
      ? scriptedModel({ text: brief })
      : new MockLanguageModelV4({ doGenerate: () => Promise.reject(new Error("provider down")) });
    models.script("track-brief", summarizer);
    const body = new FormData();
    body.set("goal", "Everything my CV says I know");
    body.append("files", new File([(await pdf(1)).slice()], "cv.pdf"));
    body.append("files", new File([DOCX.slice()], "notes.docx"));
    const response = await t.request("/api/tracks", { method: "POST", cookie, body });
    const { id } = (await response.json()) as TrackRow;
    const briefOf = async () =>
      (await t.db.select().from(tracks).where(eq(tracks.id, id)))[0]?.brief ?? null;
    await t.waitFor(async () =>
      brief ? (await briefOf()) === brief : summarizer.doGenerateCalls.length > 0,
    );
    return { cookie, trackId: id, briefOf };
  };

  const startSession = async (cookie: string, trackId: string) => {
    models.script("probe", { text: FIRST_QUESTION });
    const started = await t.request(`/api/tracks/${trackId}/sessions`, { method: "POST", cookie });
    expect(started.status).toBe(201);
    return ((await started.json()) as { id: string }).id;
  };

  const probeCall = async () => {
    await t.waitFor(() =>
      Promise.resolve(
        (models.used.find((u) => u.purpose === "probe")?.model.doStreamCalls.length ?? 0) > 0,
      ),
    );
    const call = models.used.find((u) => u.purpose === "probe")?.model.doStreamCalls[0];
    if (!call) throw new Error("no probe call");
    const system = call.prompt
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const opening = call.prompt.find((m) => m.role === "user");
    return { system, opening };
  };

  /** A session of the track that began, and closed, before any other. */
  const earlierSession = async (trackId: string) => {
    const [track] = await t.db.select().from(tracks).where(eq(tracks.id, trackId));
    await t.db.insert(learningSessions).values({
      trackId,
      userId: track?.userId ?? "",
      state: { ...initialSession(), phase: "closed" },
      createdAt: new Date(Date.now() - 86_400_000),
      closedAt: new Date(Date.now() - 80_000_000),
    });
  };

  it("summarizes the files once the track is created, reading them as they are", async () => {
    const { briefOf } = await trackWithFiles();
    expect(await briefOf()).toBe(BRIEF);
    const call = models.used.find((u) => u.purpose === "track-brief")?.model.doGenerateCalls[0];
    const content = call?.prompt.find((m) => m.role === "user")?.content;
    expect(content).toContainEqual(
      expect.objectContaining({ type: "file", mediaType: "application/pdf", filename: "cv.pdf" }),
    );
    expect(JSON.stringify(content)).toContain("Redis caching");
  });

  it("gives the first session's probe the files themselves, not their summary", async () => {
    const { cookie, trackId } = await trackWithFiles();
    await startSession(cookie, trackId);
    const { system, opening } = await probeCall();
    expect(system).not.toContain("What the learner brought");
    expect(opening?.content).toEqual([
      {
        type: "text",
        text: "(The learner started a session. They said they want to learn: Everything my CV says I know)\n\nThey attached these 2 files, which follow: cv.pdf, notes.docx.",
      },
      expect.objectContaining({ type: "file", mediaType: "application/pdf", filename: "cv.pdf" }),
      {
        type: "text",
        text: "notes.docx:\n\nAda Lovelace\n\nBackend engineer: Node.js, Postgres, Redis caching.",
      },
    ]);
  });

  it("gives the first session's plan the files too", async () => {
    const { cookie, trackId } = await trackWithFiles();
    const sessionId = await startSession(cookie, trackId);
    await probeCall();
    // The learner answers the first question once it's there, as they would.
    await until(cookie, sessionId, storedMessages(1));
    finishProbe(models);
    models.script("plan", planAttempt(PLAN_TEXT));
    await t.request(`/api/sessions/${sessionId}/messages`, {
      method: "POST",
      cookie,
      body: JSON.stringify({ text: "APIs, mostly" }),
    });
    await t.waitFor(() =>
      Promise.resolve(
        (models.used.find((u) => u.purpose === "plan")?.model.doStreamCalls.length ?? 0) > 0,
      ),
    );
    const plan = models.used.find((u) => u.purpose === "plan")?.model.doStreamCalls[0];
    expect(JSON.stringify(plan?.prompt)).toContain('"mediaType":"application/pdf"');
    const decision = models.used.find((u) => u.purpose === "probe-decision")?.model
      .doGenerateCalls[0];
    expect(JSON.stringify(decision?.prompt)).toContain('"filename":"cv.pdf"');
  });

  it("gives later sessions the summary in place of the files", async () => {
    const { cookie, trackId } = await trackWithFiles();
    await earlierSession(trackId);
    await startSession(cookie, trackId);
    const { system, opening } = await probeCall();
    expect(system).toContain(
      `## What the learner brought\n\nFiles they attached when they started the track: cv.pdf, notes.docx.\n\n${BRIEF}`,
    );
    expect(opening?.content).toEqual([
      {
        type: "text",
        text: "(The learner started a session. They said they want to learn: Everything my CV says I know)",
      },
    ]);
  });

  it("writes a missing summary before a later session's first question", async () => {
    const { cookie, trackId, briefOf } = await trackWithFiles(null);
    expect(await briefOf()).toBeNull();
    await earlierSession(trackId);
    models.script("track-brief", { text: BRIEF });
    const sessionId = await startSession(cookie, trackId);
    const { system } = await probeCall();
    expect(system).toContain(BRIEF);
    expect(await briefOf()).toBe(BRIEF);
    const reading = (await activities(sessionId)).find(
      (a) => a.label === "Reading what you brought",
    );
    expect(reading?.state).toBe("done");
  });
});
