import { attachmentKind, attachmentProblem, attachmentsProblem } from "@grounded/core";
import { useEffect, useRef, useState } from "react";

export interface PendingFile {
  id: string;
  file: File;
  image: boolean;
  /** An image's thumbnail (an object URL, revoked when the file is removed). */
  preview: string | null;
  /** Why the file can't be attached, from its name and size (the server reads what is inside). */
  problem: string | null;
}

let next = 0;

/**
 * Files chosen to attach, checked as they are added against the rules the API applies (design
 * §4.5). The same file picked twice is kept once.
 */
export function useAttachments() {
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
      const problem = attachmentProblem(file.name, file.size);
      const image = attachmentKind(file.name)?.kind === "image";
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
  const together = attachmentsProblem(files.map((f) => f.file));
  const blocked = together !== null || files.some((f) => f.problem);
  return { files, add, remove, together, blocked };
}
