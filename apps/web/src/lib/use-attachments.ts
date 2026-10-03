import { attachmentKind, attachmentProblem, attachmentsProblem } from "@grounded/core/attachments";
import { sourceProblem, sourcesProblem } from "@grounded/core/sources";
import { useEffect, useRef, useState } from "react";
import { type RefusalNotice } from "@grounded/core/notices";

export interface PendingFile {
  id: string;
  file: File;
  image: boolean;
  /** An image's thumbnail (an object URL, revoked when the file is removed). */
  preview: string | null;
  /** Why the file can't be attached, from its name and size (the server reads what is inside). */
  /** Why it can't be attached, worded by the chip. */
  problem: RefusalNotice | null;
}

let next = 0;

/**
 * What the files are for: brought, about the learner (design §4.5), or the source a track is
 * taught from (§4.6), each with the rules the API applies to it.
 */
export type AttachmentRules = "brought" | "source";

const RULES = {
  brought: {
    problem: attachmentProblem,
    together: attachmentsProblem,
    image: (name: string) => attachmentKind(name)?.kind === "image",
  },
  source: {
    problem: sourceProblem,
    // Nothing chosen yet is not a problem to show; it only holds creating back.
    together: (files: readonly { size: number }[]) => (files.length ? sourcesProblem(files) : null),
    image: () => false,
  },
} as const;

/**
 * Files chosen to attach, checked as they are added against the rules the API applies (design
 * §4.5, §4.6). The same file picked twice is kept once.
 */
export function useAttachments(rules: AttachmentRules = "brought") {
  const rule = RULES[rules];
  const [files, setFiles] = useState<PendingFile[]>([]);
  const previews = useRef(new Set<string>());

  useEffect(() => {
    const urls = previews.current;
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, []);

  // Object URLs are made and revoked here, not in a state updater, which React may run twice.
  const add = (added: readonly File[]) => {
    const fresh = added.filter(
      (file) =>
        !files.some(
          ({ file: f }) =>
            f.name === file.name && f.size === file.size && f.lastModified === file.lastModified,
        ),
    );
    const pending = fresh.map((file): PendingFile => {
      const problem = rule.problem(file.name, file.size);
      const image = rule.image(file.name);
      const preview = image && !problem ? URL.createObjectURL(file) : null;
      if (preview) previews.current.add(preview);
      next += 1;
      return { id: String(next), file, image, preview, problem };
    });
    setFiles((current) => [...current, ...pending]);
  };

  const remove = (id: string) => {
    const gone = files.find((f) => f.id === id);
    if (gone?.preview) {
      URL.revokeObjectURL(gone.preview);
      previews.current.delete(gone.preview);
    }
    setFiles((current) => current.filter((f) => f.id !== id));
  };

  /** Why the files can't go together (too many, too large); each file shows its own problem. */
  const together = rule.together(files.map((f) => f.file));
  // A source track can't be made without its source.
  const blocked =
    together !== null || files.some((f) => f.problem) || (rules === "source" && !files.length);
  return { files, add, remove, together, blocked };
}
