import type { Block, LessonStep } from "@grounded/content";
import { eq, lessons } from "@grounded/db";
import { beforeEach, describe, expect, it } from "vitest";
import type { WebAccess } from "./media/web.js";
import { createFlows, storedMessages } from "./test/flows.js";
import { createTestHarness } from "./test/harness.js";
import { scriptedModels } from "./test/scripted-models.js";

/*
 * A lesson's media, and any message's links, reach the learner only as the server verified them
 * (design §6.4), on a made-up web: Commons knows one image, and one page is gone.
 */

const asked: string[] = [];
const web: WebAccess = {
  getJson: (url) => {
    asked.push(url);
    const title = new URL(url).searchParams.get("titles");
    const pages =
      title === "File:Counter.png"
        ? [
            {
              title,
              imageinfo: [
                {
                  url: "https://upload.wikimedia.org/Counter.png",
                  descriptionurl: "https://commons.wikimedia.org/wiki/File:Counter.png",
                  mime: "image/png",
                  width: 640,
                  height: 480,
                  extmetadata: { LicenseShortName: { value: "CC0" } },
                },
              ],
            },
          ]
        : [];
    return Promise.resolve({ status: 200, body: { query: { pages } } });
  },
  probe: (url) => {
    asked.push(url);
    return Promise.resolve(url === "https://example.org/gone" ? 404 : 200);
  },
};

const models = scriptedModels();
const t = createTestHarness({ models: models.access, media: { web } });
const { learner, planned, snapshot, until } = createFlows(t, models);

beforeEach(() => {
  models.reset();
  asked.length = 0;
});

const OUTLINE = {
  title: "Why two writers lose an update",
  steps: [
    {
      heading: "Adding one is three moves",
      establishes: "copy, change, put back",
      introduces: ["working copy"],
      restsOn: [],
    },
  ],
};
const STEP = [
  "## Adding one is three moves",
  'The value is copied out, changed, and put back.\n\n:::word{term="working copy"}\nThe copy of a value that is changed before it is put back.\n:::',
  '::image{ref="commons:File:Counter.png" caption="A tally counter."}',
  '::link{url="https://example.org/gone" title="More" why="Goes further."}',
  ":::check\nWhat is in memory meanwhile?\n:::",
].join("\n\n");

describe("lesson media", () => {
  it("shows verified images with their licence, and leaves out what doesn't open after the rewrites", async () => {
    const session = await planned();
    models.script("lesson", { text: STEP, thenGenerate: [JSON.stringify(OUTLINE), STEP, STEP] });
    await t.request(`/api/sessions/${session.sessionId}/approve-plan`, {
      method: "POST",
      cookie: session.cookie,
    });
    await until(session.cookie, session.sessionId, (s) => s.lesson?.steps.length === 1);

    const [lesson] = await t.db
      .select()
      .from(lessons)
      .where(eq(lessons.sessionId, session.sessionId));
    const [stored]: (LessonStep | undefined)[] = lesson?.steps ?? [];
    expect(stored?.body.map((b: Block) => b.type)).toEqual(["paragraph", "word", "image"]);
    expect(stored?.body[2]).toMatchObject({
      type: "image",
      file: { url: "https://upload.wikimedia.org/Counter.png", license: "CC0", credit: null },
    });
    // The step and its two rewrites all linked the dead page; it was asked about once.
    expect(asked.filter((url) => url === "https://example.org/gone")).toHaveLength(1);

    // The outline could search Commons; the lesson itself was written without tools.
    const [model] = models.used.filter((u) => u.purpose === "lesson").map((u) => u.model);
    expect(model?.doGenerateCalls[0]?.tools?.map((tool) => tool.name)).toEqual([
      "find_image",
      "find_audio",
    ]);
    expect(model?.doStreamCalls[0]?.tools).toBeUndefined();
  });

  it("keeps a chat message's link that doesn't open as plain text", async () => {
    const { cookie, trackId } = await learner();
    models.script("probe", {
      text: "Have you read [this page](https://example.org/gone) or [that one](https://example.org/here)?",
    });
    const started = await t.request(`/api/tracks/${trackId}/sessions`, { method: "POST", cookie });
    const { id } = (await started.json()) as { id: string };
    await until(cookie, id, storedMessages(1));

    const [message] = (await snapshot(cookie, id)).messages;
    expect(message?.blocks).toEqual([
      expect.objectContaining({
        type: "paragraph",
        children: [
          { type: "text", value: "Have you read " },
          { type: "text", value: "this page" },
          { type: "text", value: " or " },
          {
            type: "link",
            url: "https://example.org/here",
            children: [{ type: "text", value: "that one" }],
          },
          { type: "text", value: "?" },
        ],
      }),
    ]);
  });
});
