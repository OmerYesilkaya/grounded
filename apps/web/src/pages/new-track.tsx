import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Composer } from "@/components/composer";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";

const MOD_KEY =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘" : "Ctrl";

/** A new track from the learner's own words, as many as they like (design §9.5). */
export function NewTrackPage() {
  const [goal, setGoal] = useState("");
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const create = useMutation({
    mutationFn: (text: string) =>
      api<{ id: string }>("/api/tracks", {
        method: "POST",
        body: JSON.stringify({ goal: text }),
      }),
    onSuccess: async ({ id }) => {
      await queryClient.invalidateQueries({ queryKey: ["tracks"] });
      void navigate({ to: "/tracks/$trackId", params: { trackId: id } });
    },
  });

  return (
    <main className="mx-auto w-full max-w-xl px-6 pt-24 pb-16">
      <h1 className="font-serif text-2xl font-semibold tracking-tight">A new subject</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Each subject is its own track, with its own words and its own plan. Write in whichever
        language you want to learn in.
      </p>
      <div className="mt-8 space-y-2">
        <Label htmlFor="goal">What do you want to learn?</Label>
        <Composer
          id="goal"
          label="What do you want to learn?"
          placeholder="Say where you want to get to, and where you're starting from: what you already know, what it's for, anything that makes it yours."
          value={goal}
          onChange={setGoal}
          onSubmit={(text) => {
            create.mutate(text);
          }}
          submitLabel="Create track"
          submitShortcut="mod-enter"
          minRows={5}
          autoFocus
          submitDisabled={create.isPending}
        />
        <p className="text-xs text-subtle-foreground">
          {MOD_KEY} Enter to create. A long description is fine; the track gets a short name.
        </p>
        {create.error && <p className="text-sm text-destructive">{create.error.message}</p>}
      </div>
    </main>
  );
}
