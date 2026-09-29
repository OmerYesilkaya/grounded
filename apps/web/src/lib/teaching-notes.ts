import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

/** A teaching note as the learner sees it (api: routes/profile.ts). */
export interface TeachingNote {
  id: string;
  text: string;
  /** The learner wrote it, or edited it since the tutor last did. */
  byLearner: boolean;
  revisedAt: string;
  evidence: {
    what: string;
    /** Null once the session is gone (its track was deleted). */
    session: { id: string; trackTitle: string; number: number } | null;
  }[];
}

export const teachingNotesQuery = queryOptions({
  queryKey: ["teaching-notes"],
  queryFn: () => api<TeachingNote[]>("/api/profile/notes"),
});

/** Adding, editing or removing a note; each answers with the notes as they now stand. */
export function useNoteChange() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (change: { id?: string; text?: string }) =>
      api<TeachingNote[]>(change.id ? `/api/profile/notes/${change.id}` : "/api/profile/notes", {
        method: change.id ? (change.text === undefined ? "DELETE" : "PATCH") : "POST",
        ...(change.text === undefined ? {} : { body: JSON.stringify({ text: change.text }) }),
      }),
    onSuccess: (notes) => {
      queryClient.setQueryData(teachingNotesQuery.queryKey, notes);
    },
  });
}
