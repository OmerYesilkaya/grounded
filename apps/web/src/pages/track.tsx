import { PhoneBar } from "@/components/page-bar";
import { Link } from "@tanstack/react-router";
import { AttachmentChip } from "@/components/attachment-chip";
import { FinalOutcomeCard } from "@/components/final-outcome";
import { NextSession } from "@/components/next-session";
import { OpenWork, TrackProgressView } from "@/components/track-progress";
import { useTracks } from "@/lib/tracks";

export function TrackPage({ trackId }: { trackId: string }) {
  const tracks = useTracks();
  const track = tracks.data?.find((t) => t.id === trackId);

  if (!track) return null;
  const open = track.items.filter((item) => !item.done);
  return (
    <>
      <PhoneBar />
      <main className="mx-auto w-full max-w-2xl px-6 pt-24 pb-24 max-md:pt-10">
        <p className="text-xs tracking-widest text-subtle-foreground uppercase">
          Track{track.language ? ` · taught in ${track.language}` : ""}
        </p>
        <h1 className="mt-1 font-serif text-3xl font-semibold tracking-tight">{track.title}</h1>
        <div className="mt-8">
          {/* A finished track leads with what its final found (design §7.4). */}
          {track.finishedIn && (
            <div className="mb-8">
              <FinalOutcomeCard
                sessionId={track.finishedIn}
                footer={
                  !track.openSession && (
                    <NextSession
                      track={track}
                      lead="A next session takes up what the final found."
                    />
                  )
                }
              />
            </div>
          )}
          {open.length > 0 && (
            <section className="mb-6">
              <h2 className="mb-3 text-xs tracking-widest text-subtle-foreground uppercase">
                Open now
              </h2>
              <OpenWork items={open} />
            </section>
          )}
          {!track.openSession && !track.finishedIn && <NextSession track={track} />}
        </div>
        <TrackProgressView trackId={trackId} items={track.items} />
        {track.files.length > 0 && (
          <section className="mt-10">
            <h2 className="text-xs tracking-widest text-subtle-foreground uppercase">
              What you brought
            </h2>
            <ul className="mt-3 flex flex-wrap gap-2">
              {track.files.map((file) => (
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
        )}
        {track.importedLesson && (
          <Link
            to="/tracks/$trackId/last-lesson"
            params={{ trackId }}
            className="mt-10 block rounded-md border px-4 py-3 hover:bg-muted"
          >
            <span className="block text-sm font-medium">Last lesson (from your earlier setup)</span>
            <span className="block text-sm text-subtle-foreground">
              {track.importedLesson.title}
            </span>
          </Link>
        )}
      </main>
    </>
  );
}
