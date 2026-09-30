import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { currentMessages } from "@/i18n";
import { liveProps } from "./live-props";

/** Stores a picture the learner added and says where the app serves it. */
export type UploadPicture = (file: File) => Promise<{ url: string }>;

export const PICTURE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/**
 * Stores pictures and puts each in the answer once stored: at `at`, or at the cursor. False when
 * none of the files is a picture, or the editor takes none.
 */
export function addPictures(editor: Editor, files: readonly File[], at: number | null): boolean {
  const { upload, onError, onPending } = liveProps(editor);
  const pictures = files.filter((file) => PICTURE_TYPES.includes(file.type));
  if (!upload || pictures.length === 0) return false;
  for (const file of pictures) {
    const storage = editor.storage.liveProps;
    onPending?.(++storage.pending);
    upload(file)
      .then(({ url }) => {
        const image = { type: "image", attrs: { src: url, alt: file.name } };
        if (at === null) editor.chain().focus().insertContent(image).run();
        else editor.chain().focus().insertContentAt(at, image).run();
      })
      .catch((error: unknown) => {
        onError?.(
          error instanceof Error ? error.message : currentMessages().homework.pictureNotAdded,
        );
      })
      .finally(() => {
        onPending?.(--storage.pending);
      });
  }
  return true;
}

/**
 * Pictures pasted or dropped into an answer (a photo of a notebook page, design §7.4): each is
 * stored first, then put in where it was pasted or dropped, as an image the app serves.
 */
export const PictureDrop = Extension.create({
  name: "pictureDrop",

  addProseMirrorPlugins() {
    const { editor } = this;
    return [
      new Plugin({
        key: new PluginKey("pictureDrop"),
        props: {
          handlePaste: (_view, event) =>
            addPictures(editor, [...(event.clipboardData?.files ?? [])], null),
          handleDrop: (view, event) => {
            const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? null;
            return addPictures(editor, [...(event.dataTransfer?.files ?? [])], at);
          },
        },
      }),
    ];
  },
});
