import { FileText, Image, X } from "lucide-react";
import { cn } from "@/lib/utils";

/** "340 KB", "2.1 MB". */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface AttachmentChipProps {
  name: string;
  size: number;
  image: boolean;
  /** A thumbnail for an image. */
  preview?: string | null;
  /** Why the file can't be attached; the chip shows it in place of the size. */
  problem?: string | null;
  onRemove?: () => void;
  /** Opens or downloads the file. */
  href?: string;
}

/**
 * A problem without the file's name, which the chip shows just above it: "budget.xlsx: only
 * images…" reads "Only images…", "scan.png is larger than 5 MB." reads "Larger than 5 MB.".
 */
export function reasonOnly(problem: string, name: string): string {
  for (const prefix of [`${name}: `, `${name} is `, `${name} `]) {
    if (problem.startsWith(prefix)) {
      const rest = problem.slice(prefix.length);
      return rest.charAt(0).toUpperCase() + rest.slice(1);
    }
  }
  return problem;
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
          {problem ? reasonOnly(problem, name) : formatSize(size)}
        </span>
      </span>
    </>
  );
  return (
    <li
      title={problem ?? name}
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
          aria-label={`Remove ${name}`}
          onClick={onRemove}
          className="ml-1 flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      )}
    </li>
  );
}
