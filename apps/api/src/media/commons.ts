import type { CommonsFile } from "@grounded/content";
import { z } from "zod";
import type { WebAccess } from "./web.js";

export type CommonsKind = "image" | "audio";

/** A Commons file the lesson may show, with what the writer needs to choose and caption it. */
export interface CommonsCandidate {
  kind: CommonsKind;
  /** What the lesson writes: `commons:` and the file's title ("commons:File:Octave.svg"). */
  ref: string;
  file: CommonsFile;
  /** What the file's page says it shows, as plain text; may be empty. */
  description: string;
  /** "1280×960" for an image, "54 s" for a recording. */
  size: string;
}

const API = "https://commons.wikimedia.org/w/api.php";
/** Wide enough for the reading column on a large screen; Commons serves smaller originals as they are. */
const THUMB_WIDTH = 1280;
const SEARCH_LIMIT = 6;
const DESCRIPTION_LENGTH = 300;
const METADATA = "LicenseShortName|LicenseUrl|Artist|ImageDescription";
/** Played by every current browser; a recording in none of these is offered as its MP3 version. */
const PLAYABLE = [
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/x-wav",
  "audio/flac",
  "audio/webm",
];

const metadataValue = z.object({ value: z.unknown() }).optional();
const infoSchema = z.object({
  url: z.string(),
  descriptionurl: z.string(),
  mime: z.string(),
  width: z.number().optional(),
  height: z.number().optional(),
  duration: z.number().optional(),
  thumburl: z.string().optional(),
  thumbwidth: z.number().optional(),
  thumbheight: z.number().optional(),
  derivatives: z.array(z.object({ src: z.string(), type: z.string() })).optional(),
  extmetadata: z
    .object({
      LicenseShortName: metadataValue,
      LicenseUrl: metadataValue,
      Artist: metadataValue,
      ImageDescription: metadataValue,
    })
    .optional(),
});
const responseSchema = z.object({
  query: z
    .object({
      pages: z.array(
        z.object({
          title: z.string(),
          index: z.number().optional(),
          missing: z.boolean().optional(),
          imageinfo: z.array(infoSchema).optional(),
          videoinfo: z.array(infoSchema).optional(),
        }),
      ),
    })
    .optional(),
});

/** Searches Commons for files of a kind; what can't be shown or credited is left out. */
export async function searchCommons(
  web: WebAccess,
  kind: CommonsKind,
  query: string,
): Promise<CommonsCandidate[]> {
  const filetype = kind === "image" ? "bitmap|drawing" : "audio";
  return request(web, kind, {
    generator: "search",
    gsrsearch: `${query} filetype:${filetype}`,
    gsrnamespace: "6",
    gsrlimit: String(SEARCH_LIMIT),
  });
}

/** The Commons file a ref names, or null when there is none that can be shown and credited. */
export async function lookupCommons(
  web: WebAccess,
  kind: CommonsKind,
  ref: string,
): Promise<CommonsCandidate | null> {
  const title = titleOf(ref);
  if (!title) return null;
  const [found] = await request(web, kind, { titles: title });
  return found ?? null;
}

/** The file title in a ref ("commons:File:Octave.svg" → "File:Octave.svg"), or null. */
export function titleOf(ref: string): string | null {
  const match = /^commons:(File:.+)$/i.exec(ref.trim());
  return match?.[1] ? match[1].replace(/_/g, " ") : null;
}

async function request(
  web: WebAccess,
  kind: CommonsKind,
  params: Record<string, string>,
): Promise<CommonsCandidate[]> {
  const url = new URL(API);
  const info =
    kind === "image"
      ? {
          prop: "imageinfo",
          iiprop: "url|size|mime|extmetadata",
          iiurlwidth: String(THUMB_WIDTH),
          iiextmetadatafilter: METADATA,
        }
      : {
          prop: "videoinfo",
          viprop: "url|size|mime|extmetadata|derivatives",
          viextmetadatafilter: METADATA,
        };
  for (const [key, value] of Object.entries({
    action: "query",
    format: "json",
    formatversion: "2",
    ...params,
    ...info,
  }))
    url.searchParams.set(key, value);
  const { status, body } = await web.getJson(url.toString());
  if (status !== 200) throw new Error(`Commons answered ${String(status)}`);
  const parsed = responseSchema.safeParse(body);
  if (!parsed.success) throw new Error("Commons answered in an unexpected shape");
  return (parsed.data.query?.pages ?? [])
    .filter((page) => !page.missing)
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .flatMap((page) => {
      const found = candidate(kind, page.title, page.imageinfo?.[0] ?? page.videoinfo?.[0]);
      return found ? [found] : [];
    });
}

function candidate(
  kind: CommonsKind,
  title: string,
  info: z.infer<typeof infoSchema> | undefined,
): CommonsCandidate | null {
  // A title with a double quote can't be written in the block's attribute.
  if (!info || title.includes('"')) return null;
  const meta = info.extmetadata;
  const license = plainText(meta?.LicenseShortName?.value);
  // A file is shown only with the licence it is shown under.
  if (!license) return null;
  const source = kind === "image" ? imageSource(info) : audioSource(info);
  if (!source) return null;
  return {
    kind,
    ref: `commons:${title}`,
    file: {
      url: source.url,
      page: info.descriptionurl,
      credit: plainText(meta?.Artist?.value) || null,
      license,
      licenseUrl: plainText(meta?.LicenseUrl?.value) || null,
    },
    description: plainText(meta?.ImageDescription?.value).slice(0, DESCRIPTION_LENGTH),
    size: source.size,
  };
}

function imageSource(info: z.infer<typeof infoSchema>): { url: string; size: string } | null {
  if (!info.mime.startsWith("image/")) return null;
  const width = info.thumbwidth ?? info.width;
  const height = info.thumbheight ?? info.height;
  const size = width && height ? `${String(width)}×${String(height)}` : "size unknown";
  return { url: info.thumburl ?? info.url, size };
}

function audioSource(info: z.infer<typeof infoSchema>): { url: string; size: string } | null {
  // Commons serves video through the same API; a recording has no picture.
  if (info.width || info.height) return null;
  const mp3 = info.derivatives?.find((d) => d.type.startsWith("audio/mpeg"));
  const mime = info.mime === "application/ogg" ? "audio/ogg" : info.mime;
  const url = mp3?.src ?? (PLAYABLE.includes(mime) ? info.url : null);
  if (!url) return null;
  const size = info.duration ? `${String(Math.round(info.duration))} s` : "length unknown";
  return { url, size };
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Commons metadata is HTML; the lesson shows it as plain text. */
export function plainText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity: string, name: string) => {
      if (!name.startsWith("#")) return ENTITIES[name.toLowerCase()] ?? entity;
      const hex = name[1] === "x" || name[1] === "X";
      const code = hex ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    })
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:)])/g, "$1")
    .replace(/\(\s+/g, "(")
    .trim();
}
