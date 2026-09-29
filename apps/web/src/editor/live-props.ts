import { Extension, type Editor } from "@tiptap/core";
import { useEffect } from "react";
import type { UploadPicture } from "./pictures";

/**
 * What the editor's extensions need from the component's latest props. The editor is made once
 * (a new one would start again from its first content), so its extensions read these when they
 * run, and the component hands them over after every render.
 */
export interface LiveProps {
  onChange?: ((markdown: string) => void) | undefined;
  /** Enter, with what the editor holds (which the last render's value may not have caught up to). */
  onEnter?: ((markdown: string) => void) | undefined;
  placeholder?: string | undefined;
  upload?: UploadPicture | undefined;
  onError?: ((message: string) => void) | undefined;
  onPending?: ((count: number) => void) | undefined;
}

interface LivePropsStorage {
  props: LiveProps;
  /** Pictures on their way into the answer. */
  pending: number;
  /** What a controlled editor gave out that hasn't come back as its value yet (line-editor.tsx). */
  echoes: string[];
  set: (props: LiveProps) => void;
}

declare module "@tiptap/core" {
  interface Storage {
    liveProps: LivePropsStorage;
  }
}

export const LivePropsExtension = Extension.create<unknown, LivePropsStorage>({
  name: "liveProps",
  addStorage() {
    // The editor keeps a copy of what this returns, so `set` changes the copy through `this`.
    return {
      props: {},
      pending: 0,
      echoes: [],
      set(this: LivePropsStorage, props: LiveProps) {
        this.props = props;
      },
    };
  },
});

/** The props an editor's extensions read. */
export const liveProps = (editor: Editor): LiveProps => editor.storage.liveProps.props;

/** Hands the component's latest props to its editor after every render. */
export function useLiveProps(editor: Editor, props: LiveProps): void {
  useEffect(() => {
    const before = liveProps(editor).placeholder;
    editor.storage.liveProps.set(props);
    // The placeholder is a decoration: drawn again when its words change (or first arrive).
    if (before !== props.placeholder && !editor.isDestroyed) editor.view.dispatch(editor.state.tr);
  });
}
