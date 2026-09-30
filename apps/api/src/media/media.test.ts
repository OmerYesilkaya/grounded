import { parseBlocks, parseLesson, type Block } from "@grounded/content";
import { describe, expect, it } from "vitest";
import { plainText, searchCommons } from "./commons.js";
import { createLessonMedia } from "./lesson-media.js";
import { createVerifier } from "./verify.js";
import { createWebAccess, isPublicAddress, type WebAccess } from "./web.js";
import { parseDuration } from "./youtube.js";
import { type ActivityNotice } from "@grounded/core";

/*
 * Media is found and verified against a web the test makes up: no test reaches the network.
 */

/** A Commons page as the API returns it (trimmed to what is read). */
const commonsPage = (title: string, overrides: Record<string, unknown> = {}) => ({
  title,
  index: 1,
  imageinfo: [
    {
      url: `https://upload.wikimedia.org/${title}`,
      descriptionurl: `https://commons.wikimedia.org/wiki/${title.replace(/ /g, "_")}`,
      mime: "image/png",
      width: 864,
      height: 384,
      thumburl: `https://upload.wikimedia.org/thumb/${title}`,
      thumbwidth: 864,
      thumbheight: 384,
      extmetadata: {
        LicenseShortName: { value: "CC BY-SA 4.0" },
        LicenseUrl: { value: "https://creativecommons.org/licenses/by-sa/4.0" },
        Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:Jane">Jane Doe</a>' },
        ImageDescription: { value: "Waveform of an octave &amp; a <i>cent</i>." },
      },
      ...overrides,
    },
  ],
});

const recordingPage = (title: string) => ({
  title,
  index: 1,
  videoinfo: [
    {
      url: `https://upload.wikimedia.org/${title}`,
      descriptionurl: `https://commons.wikimedia.org/wiki/${title}`,
      mime: "application/ogg",
      width: 0,
      height: 0,
      duration: 54.3,
      derivatives: [
        { src: `https://upload.wikimedia.org/${title}`, type: 'audio/ogg; codecs="vorbis"' },
        { src: `https://upload.wikimedia.org/transcoded/${title}.mp3`, type: "audio/mpeg" },
      ],
      extmetadata: { LicenseShortName: { value: "Public domain" } },
    },
  ],
});

interface FakeWeb extends WebAccess {
  asked: string[];
}

/** Answers from `json` (by a URL's search parameters) and `pages` (by URL); everything else fails. */
function fakeWeb(routes: {
  json?: (url: URL) => { status: number; body: unknown } | undefined;
  pages?: Record<string, number>;
}): FakeWeb {
  const asked: string[] = [];
  return {
    asked,
    getJson(url) {
      asked.push(url);
      const answer = routes.json?.(new URL(url));
      return answer ? Promise.resolve(answer) : Promise.reject(new Error("unreachable"));
    },
    probe(url) {
      asked.push(url);
      const status = routes.pages?.[url];
      return status === undefined
        ? Promise.reject(new Error("unreachable"))
        : Promise.resolve(status);
    },
  };
}

const commonsWith = (pages: object[]) => (url: URL) =>
  url.hostname === "commons.wikimedia.org"
    ? { status: 200, body: { query: { pages } } }
    : undefined;

const blocksOf = (markdown: string): Block[] => {
  const { blocks, issues } = parseBlocks(markdown);
  expect(issues).toEqual([]);
  return blocks;
};

describe("searchCommons", () => {
  it("returns files with what they show, their size, licence and credit as plain text", async () => {
    const web = fakeWeb({ json: commonsWith([commonsPage("File:Octave waveform.png")]) });
    const [found] = await searchCommons(web, "image", "octave waveform");

    expect(found).toEqual({
      kind: "image",
      ref: "commons:File:Octave waveform.png",
      file: {
        url: "https://upload.wikimedia.org/thumb/File:Octave waveform.png",
        page: "https://commons.wikimedia.org/wiki/File:Octave_waveform.png",
        credit: "Jane Doe",
        license: "CC BY-SA 4.0",
        licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0",
      },
      description: "Waveform of an octave & a cent.",
      size: "864×384",
    });
    const asked = new URL(web.asked[0] ?? "");
    expect(asked.searchParams.get("gsrsearch")).toBe("octave waveform filetype:bitmap|drawing");
    expect(asked.searchParams.get("prop")).toBe("imageinfo");
  });

  it("leaves out files without a licence, and recordings no browser plays", async () => {
    const unlicensed = commonsPage("File:A.png", { extmetadata: {} });
    const midi = { ...recordingPage("File:B.mid") };
    const [info] = midi.videoinfo;
    if (info) Object.assign(info, { mime: "audio/midi", derivatives: [] });
    const web = fakeWeb({ json: commonsWith([unlicensed, midi, recordingPage("File:C.ogg")]) });

    expect(await searchCommons(web, "image", "a")).toEqual([]);
    const recordings = await searchCommons(web, "audio", "violin");
    expect(recordings.map((r) => [r.ref, r.file.url, r.size])).toEqual([
      ["commons:File:C.ogg", "https://upload.wikimedia.org/transcoded/File:C.ogg.mp3", "54 s"],
    ]);
  });
});

describe("createVerifier", () => {
  it("resolves a Commons image, and drops one that isn't there", async () => {
    const web = fakeWeb({
      json: (url) =>
        url.searchParams.get("titles") === "File:Octave waveform.png"
          ? commonsWith([commonsPage("File:Octave waveform.png")])(url)
          : commonsWith([{ title: "File:Gone.png", missing: true }])(url),
    });
    const { blocks, issues } = await createVerifier({ web }).verify(
      blocksOf(
        '::image{ref="commons:File:Octave_waveform.png" caption="Two waves."}\n\n::image{ref="commons:File:Gone.png"}',
      ),
      { stepId: "s2" },
    );

    expect(blocks).toMatchObject([
      { type: "image", file: { license: "CC BY-SA 4.0", credit: "Jane Doe" } },
    ]);
    expect(issues).toMatchObject([{ code: "image/unverified", blockId: "b2", stepId: "s2" }]);
  });

  it("keeps a video that exists, drops one that doesn't, and links to one it can't embed", async () => {
    const web = fakeWeb({
      json: (url) => {
        const watched = new URL(url.searchParams.get("url") ?? "https://x").searchParams.get("v");
        const status = { dQw4w9WgXcQ: 200, private0000: 404, noEmbed0000: 401 }[watched ?? ""];
        return status ? { status, body: null } : undefined;
      },
    });
    const { blocks, issues } = await createVerifier({ web }).verify(
      blocksOf(
        [
          '::video{id="dQw4w9WgXcQ" start="12" end="40" caption="A clip."}',
          '::video{id="private0000"}',
          '::video{id="noEmbed0000" start="30" caption="Hear the chord."}',
          '::video{id="not-an-id"}',
        ].join("\n\n"),
      ),
    );

    expect(blocks).toEqual([
      expect.objectContaining({ type: "video", videoId: "dQw4w9WgXcQ" }),
      {
        id: "b3",
        type: "link",
        url: "https://www.youtube.com/watch?v=noEmbed0000&t=30s",
        title: "Watch on YouTube",
        why: "Hear the chord.",
      },
    ]);
    expect(issues.map((i) => [i.blockId, i.code])).toEqual([
      ["b2", "video/unverified"],
      ["b3", "video/unverified"],
      ["b4", "video/unverified"],
    ]);
  });

  it("checks a clip's times against the video's length when the Data API is there", async () => {
    const web = fakeWeb({
      json: (url) =>
        url.hostname === "www.googleapis.com" && url.searchParams.get("key") === "yt-key"
          ? {
              status: 200,
              body: {
                items: [{ contentDetails: { duration: "PT1M30S" }, status: { embeddable: true } }],
              },
            }
          : undefined,
    });
    const { blocks, issues } = await createVerifier({ web, youtubeKey: "yt-key" }).verify(
      blocksOf(
        '::video{id="dQw4w9WgXcQ" start="10" end="80"}\n\n::video{id="dQw4w9WgXcQ" start="85" end="200"}',
      ),
    );

    expect(blocks.map((b) => b.type)).toEqual(["video", "link"]);
    expect(issues).toMatchObject([
      { code: "video/unverified", message: expect.stringContaining("is 90 s long") as unknown },
    ]);
  });

  it("drops link cards that don't open, keeps an inline link's text, and asks about a URL once", async () => {
    const web = fakeWeb({
      pages: { "https://example.org/spec": 200, "https://example.org/gone": 404 },
    });
    const { blocks, issues } = await createVerifier({ web }).verify(
      blocksOf(
        [
          '::link{url="https://example.org/spec" title="The spec" why="Defines it."}',
          '::link{url="https://example.org/gone" title="Gone" why="Was here."}',
          "See [the spec](https://example.org/spec) and [**this**](https://nowhere.example).",
        ].join("\n\n"),
      ),
    );

    expect(blocks).toEqual([
      expect.objectContaining({ type: "link", url: "https://example.org/spec" }),
      {
        id: "b3",
        type: "paragraph",
        children: [
          { type: "text", value: "See " },
          {
            type: "link",
            url: "https://example.org/spec",
            children: [{ type: "text", value: "the spec" }],
          },
          { type: "text", value: " and " },
          { type: "strong", children: [{ type: "text", value: "this" }] },
          { type: "text", value: "." },
        ],
      },
    ]);
    expect(issues.map((i) => [i.blockId, i.code, i.message])).toEqual([
      [
        "b2",
        "link/unverified",
        "The link https://example.org/gone doesn't open (it answered 404). Link only to pages from your search results, or leave the link out.",
      ],
      ["b3", "link/unverified", expect.stringContaining("couldn't be reached")],
    ]);
    expect(web.asked.filter((u) => u === "https://example.org/spec")).toHaveLength(1);
  });

  it("drops a chart's source that doesn't open, and leaves a source that isn't an address", async () => {
    const chart = (source: string) => "```chart\nsource: " + source + '\n---\n{"mark":"bar"}\n```';
    const { blocks, issues } = await createVerifier({ web: fakeWeb({}) }).verify(
      blocksOf(`${chart("https://data.example/x")}\n\n${chart("World Bank, 2020")}`),
    );

    expect(blocks.map((b) => b.type === "chart" && b.source)).toEqual([null, "World Bank, 2020"]);
    expect(issues.map((i) => i.code)).toEqual(["chart/unverified-source"]);
  });
});

describe("createLessonMedia", () => {
  const web = () =>
    fakeWeb({
      json: (url) =>
        url.searchParams.get("generator") === "search"
          ? commonsWith([commonsPage("File:Counter.png")])(url)
          : undefined,
    });

  it("finds images for the outline, lists them for the writer, and verifies them without asking again", async () => {
    const internet = web();
    const labels: ActivityNotice[] = [];
    const media = createLessonMedia({
      web: internet,
      activity: (label, run) => {
        labels.push(label);
        return run();
      },
    });
    expect(media.found()).toBe("");

    const result: unknown = await media.tools.find_image?.execute?.(
      { query: "a mechanical counter" },
      { toolCallId: "c1", messages: [], context: {} },
    );
    expect(result).toEqual({
      files: [
        {
          ref: "commons:File:Counter.png",
          shows: "Waveform of an octave & a cent.",
          size: "864×384",
          license: "CC BY-SA 4.0",
        },
      ],
    });
    expect(labels).toEqual([
      { code: "finding-media", kind: "image", query: "a mechanical counter" },
    ]);
    expect(media.found()).toContain("- image `commons:File:Counter.png` (864×384)");

    const { steps } = parseLesson(
      '## Counting\n\nIt [counts](https://example.org).\n\n::image{ref="commons:File:Counter.png" caption="A counter."}',
    );
    const [lessonStep] = steps;
    if (!lessonStep) throw new Error("no step");
    const verified = await media.verify(lessonStep);

    expect(verified.step.body).toMatchObject([
      {
        type: "paragraph",
        children: [
          { type: "text", value: "It " },
          { type: "text", value: "counts" },
          { type: "text", value: "." },
        ],
      },
      { type: "image", file: { url: "https://upload.wikimedia.org/thumb/File:Counter.png" } },
    ]);
    expect(verified.issues).toMatchObject([{ code: "link/unverified", stepId: "s1" }]);
    // One search, and the page the link names: the found image was never looked up again.
    expect(internet.asked).toHaveLength(2);
  });

  it("tells the outline when Commons doesn't answer, instead of failing", async () => {
    const media = createLessonMedia({ web: fakeWeb({}) });
    const result: unknown = await media.tools.find_audio?.execute?.(
      { query: "violin" },
      { toolCallId: "c1", messages: [], context: {} },
    );
    expect(result).toEqual({
      files: [],
      note: "Wikimedia Commons didn't answer; go on without it.",
    });
  });
});

describe("the web as verification reaches it", () => {
  it("tells public addresses from private ones", () => {
    for (const address of ["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"])
      expect(isPublicAddress(address)).toBe(true);
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.20.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "fd12:3456::1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "not an address",
    ])
      expect(isPublicAddress(address)).toBe(false);
  });

  it("never probes a private address or anything but a web page", async () => {
    const web = createWebAccess();
    await expect(web.probe("http://127.0.0.1:9/")).rejects.toThrow("a private address");
    await expect(web.probe("http://[::1]:9/")).rejects.toThrow("a private address");
    await expect(web.probe("ftp://example.org/")).rejects.toThrow("not a web address");
    await expect(web.probe("javascript:alert(1)")).rejects.toThrow("not a web address");
    // localhost resolves on this machine, to a loopback address.
    await expect(web.probe("http://localhost:9/")).rejects.toThrow("not on the public internet");
  });
});

describe("helpers", () => {
  it("reads ISO 8601 durations", () => {
    expect(parseDuration("PT1H2M3S")).toBe(3723);
    expect(parseDuration("PT45S")).toBe(45);
    expect(parseDuration("P0D")).toBeNull();
    expect(parseDuration("soon")).toBeNull();
  });

  it("turns Commons HTML into plain text", () => {
    expect(plainText("<b>Tom</b> (<a>talk</a>) &#8212; &#x41;&nbsp;x")).toBe("Tom (talk) — A x");
    expect(plainText(undefined)).toBe("");
  });
});
