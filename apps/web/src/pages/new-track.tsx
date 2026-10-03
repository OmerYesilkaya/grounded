import { ATTACHMENT_ACCEPT } from "@grounded/core/attachments";
import { SOURCE_ACCEPT } from "@grounded/core/sources";
import { PhoneBar } from "@/components/page-bar";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { FileUp } from "lucide-react";
import { useRef, useState, type DragEvent } from "react";
import { AttachmentChip } from "@/components/attachment-chip";
import { Composer } from "@/components/composer";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useT } from "@/i18n";
import { api } from "@/lib/api";
import { useAttachments, type PendingFile } from "@/lib/use-attachments";
import { wordNotice } from "@/i18n/notice";
import { cn } from "@/lib/utils";

const MOD_KEY =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘" : "Ctrl";

type StartFrom = "words" | "source";

/**
 * A new track (design §9.5), started one of two ways, chosen explicitly: from the learner's own
 * words, as many as they like, with files that show where they start or where they are heading; or
 * from a source they bring (a book, a long PDF, notes; §4.6), with optional notes on why they are
 * reading it.
 */
export function NewTrackPage({ initialGoal = "" }: { initialGoal?: string | undefined }) {
  const [from, setFrom] = useState<StartFrom>("words");
  const [goal, setGoal] = useState(initialGoal);
  const all = useT();
  const t = all.session.newTrack;
  const brought = useAttachments("brought");
  const sources = useAttachments("source");
  const attachments = from === "words" ? brought : sources;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const create = useMutation({
    mutationFn: (text: string) => {
      const body = new FormData();
      body.set("goal", text);
      for (const { file } of attachments.files) body.append("files", file);
      // A source track is named in the address: the API sets its upload limit by it.
      const path = from === "source" ? "/api/tracks?from=source" : "/api/tracks";
      return api<{ id: string }>(path, { method: "POST", body });
    },
    onSuccess: async ({ id }) => {
      await queryClient.invalidateQueries({ queryKey: ["tracks"] });
      void navigate({ to: "/tracks/$trackId", params: { trackId: id } });
    },
  });
  const label = from === "words" ? t.question : t.notes;

  return (
    <>
      <PhoneBar />
      <main className="mx-auto w-full max-w-xl px-6 pt-24 pb-16 max-md:pt-10">
        <h1 className="font-serif text-2xl font-semibold tracking-tight">{t.title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t.intro}</p>
        <div
          role="radiogroup"
          aria-label={t.startFrom}
          className="mt-8 grid grid-cols-2 gap-1 rounded-lg border bg-muted/40 p-1 text-sm"
        >
          {(["words", "source"] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={from === option}
              disabled={create.isPending}
              onClick={() => {
                setFrom(option);
              }}
              className={cn(
                "rounded-md px-3 py-2 font-medium transition-colors",
                from === option
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {option === "words" ? t.fromWords : t.fromSource}
            </button>
          ))}
        </div>
        {from === "source" && (
          <>
            <p className="mt-6 text-sm text-muted-foreground">{t.fromSourceIntro}</p>
            <SourcePicker
              files={sources.files}
              onAdd={sources.add}
              onRemove={sources.remove}
              disabled={create.isPending}
            />
          </>
        )}
        <div className="mt-8 space-y-2">
          <Label htmlFor="goal">{label}</Label>
          <Composer
            // A fresh box per mode, so its label and placeholder are its own.
            key={from}
            id="goal"
            label={label}
            placeholder={from === "words" ? t.placeholder : t.notesPlaceholder}
            value={goal}
            onChange={setGoal}
            onSubmit={(text) => {
              create.mutate(text);
            }}
            submitLabel={create.isPending ? t.creating : t.create}
            submitShortcut="mod-enter"
            minRows={from === "words" ? 5 : 3}
            autoFocus={from === "words"}
            allowEmpty={from === "source"}
            submitDisabled={create.isPending || attachments.blocked}
            disabled={create.isPending}
            {...(from === "words"
              ? {
                  onAddFiles: brought.add,
                  accept: ATTACHMENT_ACCEPT,
                  attachments: brought.files.length > 0 && (
                    <ChipList label={t.attached} files={brought.files} onRemove={brought.remove} />
                  ),
                }
              : {})}
          />
          <p className="text-xs text-subtle-foreground">
            {from === "words" && t.attachHint}{" "}
            <span className="pointer-coarse:hidden">{t.shortcut(MOD_KEY)}</span>
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

function ChipList(props: {
  label: string;
  files: readonly PendingFile[];
  onRemove: (id: string) => void;
}) {
  return (
    <ul aria-label={props.label} className="flex flex-wrap gap-2 px-3 pt-1 pb-2">
      {props.files.map((f) => (
        <AttachmentChip
          key={f.id}
          name={f.file.name}
          size={f.file.size}
          image={f.image}
          preview={f.preview}
          problem={f.problem}
          onRemove={() => {
            props.onRemove(f.id);
          }}
        />
      ))}
    </ul>
  );
}

/** Where a source track's files go: a button that opens the picker, and a place to drop them. */
function SourcePicker(props: {
  files: readonly PendingFile[];
  onAdd: (files: File[]) => void;
  onRemove: (id: string) => void;
  disabled: boolean;
}) {
  const t = useT().session.newTrack;
  const picker = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const carriesFiles = (event: DragEvent) =>
    !props.disabled && event.dataTransfer.types.includes("Files");
  return (
    <section className="mt-6 space-y-2">
      <h2 className="text-sm font-medium">{t.sources}</h2>
      <div
        onDragOver={(event) => {
          if (!carriesFiles(event)) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => {
          setDragging(false);
        }}
        onDrop={(event) => {
          if (!carriesFiles(event)) return;
          event.preventDefault();
          setDragging(false);
          props.onAdd([...event.dataTransfer.files]);
        }}
        className={cn(
          "rounded-lg border border-dashed px-4 py-5 text-center text-sm",
          dragging && "border-primary bg-primary/5",
        )}
      >
        <p className="text-muted-foreground">{t.dropSource}</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-2"
          disabled={props.disabled}
          onClick={() => picker.current?.click()}
        >
          <FileUp aria-hidden />
          {t.addSource}
        </Button>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          accept={SOURCE_ACCEPT}
          aria-label={t.addSource}
          onChange={(event) => {
            const chosen = [...(event.target.files ?? [])];
            event.target.value = "";
            if (chosen.length) props.onAdd(chosen);
          }}
        />
        {props.files.length > 0 && (
          <div className="mt-3 text-left">
            <ChipList label={t.sources} files={props.files} onRemove={props.onRemove} />
          </div>
        )}
      </div>
      <p className="text-xs text-subtle-foreground">{t.sourceHint}</p>
    </section>
  );
}
