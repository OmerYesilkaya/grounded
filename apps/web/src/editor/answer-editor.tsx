import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "@tiptap/markdown";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { ImagePlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { liveProps, LivePropsExtension, useLiveProps } from "./live-props";
import { AnswerBlockMath, AnswerInlineMath } from "./math";
import { addPictures, PICTURE_TYPES, PictureDrop, type UploadPicture } from "./pictures";
import "./editor.css";

/**
 * The answer editor (design §7.4): markdown as the learner types it (`#`, `-`, `**`, `` ` ``, ```
 * for a code block), `$…$` maths, and pictures pasted, dropped or picked (a photo of a notebook
 * page). What it holds is markdown, the same the tutor writes; `onChange` gets it as it changes.
 */
export function AnswerEditor(props: {
  /** The markdown it starts with; later changes to it aren't taken in. */
  initial: string;
  onChange: (markdown: string) => void;
  /** The field's accessible name. */
  label: string;
  placeholder?: string | undefined;
  /** Shown only: a locked prediction, a handed-in answer. */
  readOnly?: boolean;
  /** Where pictures go; without it, pictures can't be added. */
  upload?: UploadPicture | undefined;
  onError?: ((message: string) => void) | undefined;
  className?: string;
}) {
  const [pending, setPending] = useState(0);
  const picker = useRef<HTMLInputElement>(null);

  // Made once: a new editor would start again from `initial`. Its extensions read the latest
  // props (live-props.ts).
  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({ link: { openOnClick: false }, heading: { levels: [2, 3] } }),
        Markdown,
        Image,
        AnswerInlineMath,
        AnswerBlockMath,
        LivePropsExtension,
        Placeholder.configure({ placeholder: ({ editor }) => liveProps(editor).placeholder ?? "" }),
        PictureDrop,
      ],
      content: props.initial,
      contentType: "markdown",
      editable: !props.readOnly,
      editorProps: {
        attributes: {
          role: "textbox",
          "aria-multiline": "true",
          "aria-label": props.label,
          class: "answer-prose",
        },
      },
      onUpdate: ({ editor }) => {
        liveProps(editor).onChange?.(editor.getMarkdown());
      },
    },
    [],
  );
  useLiveProps(editor, {
    onChange: props.onChange,
    placeholder: props.placeholder,
    upload: props.upload,
    onError: props.onError,
    onPending: setPending,
  });

  useEffect(() => {
    editor.setEditable(!props.readOnly);
  }, [editor, props.readOnly]);

  return (
    <div
      className={cn(
        "answer-editor rounded-lg border bg-background transition-colors focus-within:border-border-strong",
        props.readOnly &&
          "rounded-none border-0 border-l-2 border-l-border-strong bg-transparent pl-4",
        props.className,
      )}
    >
      <EditorContent editor={editor} />
      {!props.readOnly && (
        <div className="flex items-center gap-3 px-3.5 pb-2 text-[11.5px] text-subtle-foreground">
          <span className="min-w-0 flex-1 truncate">
            {pending > 0
              ? "Adding the picture…"
              : "**bold** · `code` · ``` code block · $x^2$ maths · paste a photo"}
          </span>
          {props.upload && (
            <>
              <button
                type="button"
                onClick={() => picker.current?.click()}
                className="flex shrink-0 items-center gap-1 rounded px-1 py-0.5 outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <ImagePlus className="size-3.5" aria-hidden />
                Add a picture
              </button>
              <input
                ref={picker}
                type="file"
                accept={PICTURE_TYPES.join(",")}
                multiple
                hidden
                onChange={(event) => {
                  addPictures(editor, [...(event.target.files ?? [])], null);
                  // The same picture can be picked again.
                  event.target.value = "";
                }}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}
