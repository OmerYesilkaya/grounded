import { Extension, Node, type JSONContent } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Fragment, Slice } from "@tiptap/pm/model";
import { useEffect, type RefObject } from "react";
import { liveProps, LivePropsExtension, useLiveProps } from "./live-props";
import { AnswerInlineMath } from "./math";
import "./editor.css";

/*
 * The one-line version of the answer editor (design §7.4), for check answers and questions in the
 * margin: one paragraph (Shift+Enter breaks the line), with `code`, **bold**, *italics* and `$…$`
 * maths typed as markdown. Enter sends. What it holds is that markdown, a line break as "\n".
 */

/** One paragraph, nothing else. */
const OneParagraph = Node.create({ name: "doc", topNode: true, content: "paragraph" });

/** Enter sends (unless an IME composition is being confirmed); Shift+Enter breaks the line. */
const EnterSends = Extension.create({
  name: "enterSends",
  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        if (editor.view.composing) return false;
        liveProps(editor).onEnter?.(lineMarkdown(editor.state.doc));
        return true;
      },
    };
  },
});

/** The line as markdown: marks as their markers, a formula as `$…$`, a break as "\n". */
export function lineMarkdown(doc: PMNode): string {
  let out = "";
  doc.descendants((node) => {
    if (node.type.name === "hardBreak") out += "\n";
    else if (node.type.name === "inlineMath") out += `$${String(node.attrs.latex ?? "")}$`;
    else if (node.isText) {
      let text = node.text ?? "";
      for (const mark of node.marks) {
        if (mark.type.name === "code") text = `\`${text}\``;
        else if (mark.type.name === "bold") text = `**${text}**`;
        else if (mark.type.name === "italic") text = `*${text}*`;
      }
      out += text;
    }
    return true;
  });
  return out;
}

/** Text put in from outside (a draft, or "" to clear): its lines, without reading its markers. */
function lineContent(text: string): JSONContent {
  const content: JSONContent[] = [];
  text.split("\n").forEach((line, i) => {
    if (i > 0) content.push({ type: "hardBreak" });
    if (line) content.push({ type: "text", text: line });
  });
  return { type: "doc", content: [{ type: "paragraph", content }] };
}

export function LineEditor(props: {
  value: string;
  onChange: (markdown: string) => void;
  /** Enter was pressed: with the line as it is now, a keystroke ahead of `value`, perhaps. */
  onEnter: (markdown: string) => void;
  label: string;
  id?: string | undefined;
  placeholder?: string | undefined;
  disabled?: boolean;
  /** The editable element, for focusing it. */
  fieldRef?: RefObject<HTMLElement | null>;
}) {
  // Made once: its extensions read the latest props (live-props.ts), and the effects below apply
  // the rest.
  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          document: false,
          heading: false,
          blockquote: false,
          bulletList: false,
          orderedList: false,
          listItem: false,
          listKeymap: false,
          codeBlock: false,
          horizontalRule: false,
          link: false,
          strike: false,
          underline: false,
          trailingNode: false,
        }),
        OneParagraph,
        AnswerInlineMath,
        EnterSends,
        LivePropsExtension,
        Placeholder.configure({ placeholder: ({ editor }) => liveProps(editor).placeholder ?? "" }),
      ],
      content: lineContent(props.value),
      editable: !props.disabled,
      editorProps: {
        attributes: {
          role: "textbox",
          "aria-multiline": "true",
          "aria-label": props.label,
          ...(props.id ? { id: props.id } : {}),
          class: "line-prose",
        },
        // Pasted lines stay one paragraph, broken where they were.
        handlePaste: (view, event) => {
          const text = event.clipboardData?.getData("text/plain");
          if (!text || event.clipboardData?.files.length) return false;
          const line = lineContent(text).content?.[0]?.content ?? [];
          const nodes = line.map((node) => view.state.schema.nodeFromJSON(node));
          view.dispatch(view.state.tr.replaceSelection(new Slice(Fragment.from(nodes), 0, 0)));
          return true;
        },
      },
      onUpdate: ({ editor }) => {
        const markdown = lineMarkdown(editor.state.doc);
        editor.storage.liveProps.echoes.push(markdown);
        liveProps(editor).onChange?.(markdown);
      },
    },
    [],
  );
  useLiveProps(editor, {
    onChange: props.onChange,
    onEnter: props.onEnter,
    placeholder: props.placeholder,
  });

  // Before the composer's effects, which focus it.
  const { fieldRef } = props;
  useEffect(() => {
    if (fieldRef) fieldRef.current = editor.view.dom;
  }, [editor, fieldRef]);

  // A value from outside (cleared after sending, say) is put in; one the editor gave out is only
  // its echo, perhaps a keystroke behind the editor (the learner types faster than React renders).
  useEffect(() => {
    const { echoes } = editor.storage.liveProps;
    const current = lineMarkdown(editor.state.doc);
    const echo = echoes.indexOf(props.value);
    if (props.value === current) echoes.splice(0);
    // The echoes before this one have come back too.
    else if (echo !== -1) echoes.splice(0, echo + 1);
    else {
      echoes.splice(0);
      editor.commands.setContent(lineContent(props.value), { emitUpdate: false });
    }
  }, [editor, props.value]);

  useEffect(() => {
    editor.view.dom.setAttribute("aria-label", props.label);
  }, [editor, props.label]);

  useEffect(() => {
    editor.setEditable(!props.disabled);
    editor.view.dom.setAttribute("aria-disabled", props.disabled ? "true" : "false");
  }, [editor, props.disabled]);

  return <EditorContent editor={editor} className="line-field px-4 pt-3 pb-1" />;
}
