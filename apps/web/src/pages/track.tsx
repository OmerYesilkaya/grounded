import { useMutation, useQueryClient } from "@tanstack/react-query";
import { PhoneBar } from "@/components/page-bar";
import { Link, useNavigate } from "@tanstack/react-router";
import { AttachmentChip } from "@/components/attachment-chip";
import { OpenWork, TrackProgressView } from "@/components/track-progress";
import { Button } from "@/components/ui/button";
import { api, ApiError } from "@/lib/api";
import { useTracks } from "@/lib/tracks";

export function TrackPage({ trackId }: { trackId: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const tracks = useTracks();
  const track = tracks.data?.find((t) => t.id === trackId);
  const start = useMutation({
    mutationFn: () => api<{ id: string }>(`/api/tracks/${trackId}/sessions`, { method: "POST" }),
    onSuccess: async ({ id }) => {
      await queryClient.invalidateQueries({ queryKey: ["tracks"] });
      void navigate({ to: "/sessions/$sessionId", params: { sessionId: id } });
    },
  });

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
          {open.length > 0 && (
            <section className="mb-6">
              <h2 className="mb-3 text-xs tracking-widest text-subtle-foreground uppercase">
                Open now
              </h2>
              <OpenWork items={open} />
            </section>
          )}
          {!track.openSession && (
            <Button
              disabled={start.isPending}
              onClick={() => {
                start.mutate();
              }}
            >
              Start a session
            </Button>
          )}
          {start.error && (
            <p className="mt-3 text-sm text-destructive">
              {start.error instanceof ApiError ? start.error.message : "Couldn't start."}
            </p>
          )}
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
