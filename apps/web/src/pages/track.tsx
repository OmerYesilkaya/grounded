import { PhoneBar } from "@/components/page-bar";
import { Link } from "@tanstack/react-router";
import { AttachmentChip } from "@/components/attachment-chip";
import { FinalOutcomeCard } from "@/components/final-outcome";
import { NextSession } from "@/components/next-session";
import { OpenWork, TrackProgressView } from "@/components/track-progress";
import { SourceCoverageView, SourceReadingCard } from "@/components/track-source";
import { useT } from "@/i18n";
import { useTracks } from "@/lib/tracks";

export function TrackPage({ trackId }: { trackId: string }) {
  const tracks = useTracks();
  const all = useT();
  const t = all.track.page;
  const tSource = all.track.source;
  const track = tracks.data?.find((each) => each.id === trackId);

  if (!track) return null;
  const open = track.items.filter((item) => !item.done);
  // A track taught from a source starts once the source is read (design §4.6).
  const unread = track.source !== null && track.source.status !== "ready";
  const sources = track.files.filter((file) => file.role === "source");
  const brought = track.files.filter((file) => file.role === "brought");
  return (
    <>
      <PhoneBar />
      <main className="mx-auto w-full max-w-2xl px-6 pt-24 pb-24 max-md:pt-10">
        <p className="text-xs tracking-widest text-subtle-foreground uppercase">
          {track.language ? t.taughtIn(track.language) : t.eyebrow}
        </p>
        <h1 className="mt-1 font-serif text-3xl font-semibold tracking-tight">{track.title}</h1>
        <div className="mt-8">
          {/* A finished track leads with what its final found (design §7.4). */}
          {track.finishedIn && (
            <div className="mb-8">
              <FinalOutcomeCard
                sessionId={track.finishedIn}
                footer={!track.openSession && <NextSession track={track} lead={t.afterFinal} />}
              />
            </div>
          )}
          {open.length > 0 && (
            <section className="mb-6">
              <h2 className="mb-3 text-xs tracking-widest text-subtle-foreground uppercase">
                {t.openNow}
              </h2>
              <OpenWork items={open} />
            </section>
          )}
          {track.source && unread && <SourceReadingCard trackId={trackId} reading={track.source} />}
          {!track.openSession && !track.finishedIn && !unread && <NextSession track={track} />}
        </div>
        <TrackProgressView trackId={trackId} items={track.items} />
        {track.source?.status === "ready" && <SourceCoverageView trackId={trackId} />}
        {[
          { files: sources, heading: tSource.title },
          { files: brought, heading: t.brought },
        ].map(
          ({ files, heading }) =>
            files.length > 0 && (
              <section key={heading} className="mt-10">
                <h2 className="text-xs tracking-widest text-subtle-foreground uppercase">
                  {heading}
                </h2>
                <ul className="mt-3 flex flex-wrap gap-2">
                  {files.map((file) => (
                    <AttachmentChip
                      key={file.id}
                      name={file.name}
                      size={file.sizeBytes}
                      image={file.kind === "image"}
                      href={`/api/tracks/${trackId}/files/${file.id}`}
                    />
                  ))}
                </ul>
              </section>
            ),
        )}
        {track.importedLesson && (
          <Link
            to="/tracks/$trackId/last-lesson"
            params={{ trackId }}
            className="mt-10 block rounded-md border px-4 py-3 hover:bg-muted"
          >
            <span className="block text-sm font-medium">{t.lastLesson}</span>
            <span className="block text-sm text-subtle-foreground">
              {track.importedLesson.title}
            </span>
          </Link>
        )}
      </main>
    </>
  );
}
