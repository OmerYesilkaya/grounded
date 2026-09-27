import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";

export function NewTrackPage() {
  const [title, setTitle] = useState("");
  const [language, setLanguage] = useState("English");
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const create = useMutation({
    mutationFn: () =>
      api<{ id: string }>("/api/tracks", {
        method: "POST",
        body: JSON.stringify({ title, language }),
      }),
    onSuccess: async ({ id }) => {
      await queryClient.invalidateQueries({ queryKey: ["tracks"] });
      void navigate({ to: "/tracks/$trackId", params: { trackId: id } });
    },
  });

  return (
    <main className="mx-auto w-full max-w-md px-6 pt-24">
      <h1 className="font-serif text-2xl font-semibold tracking-tight">A new subject</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Each subject is its own track, with its own words and its own plan.
      </p>
      <form
        className="mt-8 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <div className="space-y-2">
          <Label htmlFor="title">What do you want to learn?</Label>
          <Input
            id="title"
            placeholder="How software works"
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
            }}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="language">Teach me in</Label>
          <Input
            id="language"
            value={language}
            onChange={(event) => {
              setLanguage(event.target.value);
            }}
          />
        </div>
        <Button type="submit" disabled={!title.trim() || create.isPending}>
          Create track
        </Button>
        {create.error && <p className="text-sm text-destructive">{create.error.message}</p>}
      </form>
    </main>
  );
}
