import { ATTACHMENT_ACCEPT } from "@grounded/core/attachments";
import { PhoneBar } from "@/components/page-bar";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { AttachmentChip } from "@/components/attachment-chip";
import { Composer } from "@/components/composer";
import { Label } from "@/components/ui/label";
import { useT } from "@/i18n";
import { api } from "@/lib/api";
import { useAttachments } from "@/lib/use-attachments";
import { wordNotice } from "@/i18n/notice";

const MOD_KEY =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘" : "Ctrl";

/**
 * A new track from the learner's own words, as many as they like, and the files that show where
 * they start or where they are heading (design §9.5).
 */
export function NewTrackPage({ initialGoal = "" }: { initialGoal?: string | undefined }) {
  const [goal, setGoal] = useState(initialGoal);
  const all = useT();
  const t = all.session.newTrack;
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
        <h1 className="font-serif text-2xl font-semibold tracking-tight">{t.title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t.intro}</p>
        <div className="mt-8 space-y-2">
          <Label htmlFor="goal">{t.question}</Label>
          <Composer
            id="goal"
            label={t.question}
            placeholder={t.placeholder}
            value={goal}
            onChange={setGoal}
            onSubmit={(text) => {
              create.mutate(text);
            }}
            submitLabel={create.isPending ? t.creating : t.create}
            submitShortcut="mod-enter"
            minRows={5}
            autoFocus
            submitDisabled={create.isPending || attachments.blocked}
            disabled={create.isPending}
            onAddFiles={attachments.add}
            accept={ATTACHMENT_ACCEPT}
            attachments={
              attachments.files.length > 0 && (
                <ul aria-label={t.attached} className="flex flex-wrap gap-2 px-3 pt-1 pb-2">
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
            {t.attachHint} <span className="pointer-coarse:hidden">{t.shortcut(MOD_KEY)}</span>
          </p>
          {attachments.together && (
            <p className="text-sm text-destructive">{wordNotice(attachments.together, all)}</p>
          )}
          {create.error && <p className="text-sm text-destructive">{create.error.message}</p>}
        </div>
      </main>
    </>
  );
}
