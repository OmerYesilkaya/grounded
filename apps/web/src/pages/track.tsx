import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import type { TrackSummary } from "@/components/track-sidebar";
import { api, ApiError } from "@/lib/api";

export function TrackPage({ trackId }: { trackId: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const tracks = useQuery({
    queryKey: ["tracks"],
    queryFn: () => api<TrackSummary[]>("/api/tracks"),
  });
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
    </main>
  );
}
