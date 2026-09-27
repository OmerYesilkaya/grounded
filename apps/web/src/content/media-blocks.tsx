import type { Block } from "@grounded/content";
import { useContentEnvironment } from "./environment";
import { hostname } from "./visual-blocks";

const unavailable = (
  <p className="my-4 font-sans text-sm text-subtle-foreground">Media unavailable</p>
);

export function ImageView({ block }: { block: Extract<Block, { type: "image" }> }) {
  const media = useContentEnvironment().media(block.ref, "image");
  if (!media) return unavailable;
  const credit = [media.credit, media.license].filter(Boolean).join(" · ");
  return (
    <figure data-block={block.id} className="my-6">
      <img
        src={media.url}
        alt={block.caption ?? ""}
        loading="lazy"
        className="mx-auto max-h-[480px] rounded-lg"
      />
      {(block.caption ?? credit) && (
        <figcaption className="mt-2 text-center font-sans text-[13.5px] text-muted-foreground">
          {block.caption}
          {credit && <span className="block text-xs text-subtle-foreground">{credit}</span>}
        </figcaption>
      )}
    </figure>
  );
}

export function AudioView({ block }: { block: Extract<Block, { type: "audio" }> }) {
  const media = useContentEnvironment().media(block.ref, "audio");
  if (!media) return unavailable;
  return (
    <figure data-block={block.id} className="my-6 rounded-lg border bg-card p-4">
      <audio controls preload="none" src={media.url} className="w-full" />
      {block.caption && (
        <figcaption className="mt-2 font-sans text-[13.5px] text-muted-foreground">
          {block.caption}
        </figcaption>
      )}
    </figure>
  );
}

export function VideoView({ block }: { block: Extract<Block, { type: "video" }> }) {
  const params = new URLSearchParams();
  if (block.start !== null) params.set("start", String(block.start));
  if (block.end !== null) params.set("end", String(block.end));
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return (
    <figure data-block={block.id} className="my-6">
      <iframe
        title={block.caption ?? "Video"}
        src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(block.videoId)}${query}`}
        loading="lazy"
        allow="encrypted-media; picture-in-picture"
        allowFullScreen
        className="aspect-video w-full rounded-lg border"
      />
      {block.caption && (
        <figcaption className="mt-2 text-center font-sans text-[13.5px] text-muted-foreground">
          {block.caption}
        </figcaption>
      )}
    </figure>
  );
}

export function LinkCardView({ block }: { block: Extract<Block, { type: "link" }> }) {
  return (
    <a
      data-block={block.id}
      href={block.url}
      target="_blank"
      rel="noopener noreferrer"
      className="my-5 block rounded-lg border bg-card px-4 py-3 font-sans no-underline transition-colors hover:border-border-strong"
    >
      <span className="block text-sm font-medium text-foreground">{block.title}</span>
      <span className="mt-0.5 block text-[13.5px] text-muted-foreground">{block.why}</span>
      <span className="mt-1 block text-xs text-subtle-foreground">{hostname(block.url)}</span>
    </a>
  );
}
