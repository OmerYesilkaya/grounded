import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
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
  return (
    <main className="mx-auto w-full max-w-xl px-6 pt-24">
      <p className="text-xs tracking-widest text-subtle-foreground uppercase">
        Track{track.language ? ` · taught in ${track.language}` : ""}
      </p>
      <h1 className="mt-1 font-serif text-3xl font-semibold tracking-tight">{track.title}</h1>
      <div className="mt-8">
        {track.openSession ? (
          <Button
            onClick={() => {
              void navigate({
                to: "/sessions/$sessionId",
                params: { sessionId: track.openSession?.id ?? "" },
              });
            }}
          >
            Continue the session
          </Button>
        ) : (
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
      {track.importedLesson && (
        <Link
          to="/tracks/$trackId/last-lesson"
          params={{ trackId }}
          className="mt-10 block rounded-md border px-4 py-3 hover:bg-muted"
        >
          <span className="block text-sm font-medium">Last lesson (from your earlier setup)</span>
          <span className="block text-sm text-subtle-foreground">{track.importedLesson.title}</span>
        </Link>
      )}
    </main>
  );
}
