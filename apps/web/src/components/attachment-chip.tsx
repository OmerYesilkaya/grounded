import type { RefusalNotice } from "@grounded/core/notices";
import { FileText, Image, X } from "lucide-react";
import { useFormat, useT, type Formats, type Messages } from "@/i18n";
import { wordNotice } from "@/i18n/notice";
import { cn } from "@/lib/utils";

/** "340 KB", "2.1 MB" ("2,1 MB" in Turkish). */
export function formatSize(bytes: number, t: Messages["session"], format: Formats): string {
  if (bytes < 1024) return t.attachment.bytes(format.number(bytes));
  if (bytes < 1024 * 1024) return t.attachment.kilobytes(format.number(Math.round(bytes / 1024)));
  return t.attachment.megabytes(
    format.number(bytes / (1024 * 1024), { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
  );
}

export interface AttachmentChipProps {
  name: string;
  size: number;
  image: boolean;
  /** A thumbnail for an image. */
  preview?: string | null;
  /** Why the file can't be attached; the chip shows it in place of the size. */
  problem?: RefusalNotice | null;
  onRemove?: () => void;
  /** Opens or downloads the file. */
  href?: string;
}

/**
 * A problem without the file's name, which the chip shows just above it: "Only images…",
 * "Larger than 5 MB."; anything else as the API words it.
 */
export function reasonOnly(problem: RefusalNotice, t: Messages, format: Formats): string {
  switch (problem.code) {
    case "attachment-kind":
      return t.session.attachment.kind;
    case "attachment-empty":
      return t.session.attachment.empty;
    case "attachment-too-large":
      return t.session.attachment.tooLarge(format.number(problem.megabytes));
    default:
      return wordNotice(problem, t);
  }
}

/** A file attached to a message or a track: its kind, name and size, and a way to remove it. */
export function AttachmentChip({
  name,
  size,
  image,
  preview,
  problem,
  onRemove,
  href,
}: AttachmentChipProps) {
  const Icon = image ? Image : FileText;
  const all = useT();
  const t = all.session;
  const format = useFormat();
  const label = (
    <>
      {preview ? (
        <img src={preview} alt="" className="size-8 shrink-0 rounded object-cover" />
      ) : (
        <span className="flex size-8 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
          <Icon className="size-4" />
        </span>
      )}
      <span className="min-w-0">
        <span className="block truncate text-[13px] leading-tight font-medium">{name}</span>
        <span
          className={cn(
            "block truncate text-xs leading-tight",
            problem ? "text-destructive" : "text-subtle-foreground",
          )}
        >
          {problem ? reasonOnly(problem, all, format) : formatSize(size, t, format)}
        </span>
      </span>
    </>
  );
  return (
    <li
      title={problem ? wordNotice(problem, all) : name}
      className={cn(
        "flex max-w-full min-w-0 items-center gap-2 rounded-lg border bg-background py-1 pr-1 pl-1",
        problem && "border-destructive/60",
        !onRemove && "pr-3",
      )}
    >
      {href ? (
        <a href={href} download={name} className="flex min-w-0 items-center gap-2 hover:underline">
          {label}
        </a>
      ) : (
        label
      )}
      {onRemove && (
        <button
          type="button"
          aria-label={t.attachment.remove(name)}
          onClick={onRemove}
          className="ml-1 flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      )}
    </li>
  );
}
