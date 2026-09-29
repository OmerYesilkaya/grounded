import { ACCEPTED_DESCRIPTION, ATTACHMENT_ACCEPT } from "@grounded/core/attachments";
import { PhoneBar } from "@/components/page-bar";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { AttachmentChip } from "@/components/attachment-chip";
import { Composer } from "@/components/composer";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { useAttachments } from "@/lib/use-attachments";

const MOD_KEY =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘" : "Ctrl";

/**
 * A new track from the learner's own words, as many as they like, and the files that show where
 * they start or where they are heading (design §9.5).
 */
export function NewTrackPage({ initialGoal = "" }: { initialGoal?: string | undefined }) {
  const [goal, setGoal] = useState(initialGoal);
  const attachments = useAttachments();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const create = useMutation({
    mutationFn: (text: string) => {
      const body = new FormData();
      body.set("goal", text);
      for (const { file } of attachments.files) body.append("files", file);
      return api<{ id: string }>("/api/tracks", { method: "POST", body });
    },
    onSuccess: async ({ id }) => {
      await queryClient.invalidateQueries({ queryKey: ["tracks"] });
      void navigate({ to: "/tracks/$trackId", params: { trackId: id } });
    },
  });

  return (
    <>
      <PhoneBar />
      <main className="mx-auto w-full max-w-xl px-6 pt-24 pb-16 max-md:pt-10">
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
            submitLabel={create.isPending ? "Creating…" : "Create track"}
            submitShortcut="mod-enter"
            minRows={5}
            autoFocus
            submitDisabled={create.isPending || attachments.blocked}
            disabled={create.isPending}
            onAddFiles={attachments.add}
            accept={ATTACHMENT_ACCEPT}
            attachments={
              attachments.files.length > 0 && (
                <ul aria-label="Attached files" className="flex flex-wrap gap-2 px-3 pt-1 pb-2">
                  {attachments.files.map((f) => (
                    <AttachmentChip
                      key={f.id}
                      name={f.file.name}
                      size={f.file.size}
                      image={f.image}
                      preview={f.preview}
                      problem={f.problem}
                      onRemove={() => {
                        attachments.remove(f.id);
                      }}
                    />
                  ))}
                </ul>
              )
            }
          />
          <p className="text-xs text-subtle-foreground">
            Attach anything that shows where you start or where you&rsquo;re heading: a CV, a
            syllabus, notes, a photo of a page ({ACCEPTED_DESCRIPTION}).{" "}
            <span className="pointer-coarse:hidden">{MOD_KEY} Enter to create.</span>
          </p>
          {attachments.together && (
            <p className="text-sm text-destructive">{attachments.together}</p>
          )}
          {create.error && <p className="text-sm text-destructive">{create.error.message}</p>}
        </div>
      </main>
    </>
  );
}
