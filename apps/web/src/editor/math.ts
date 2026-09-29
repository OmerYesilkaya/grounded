import { InputRule, type Editor } from "@tiptap/core";
import { BlockMath, InlineMath } from "@tiptap/extension-mathematics";
import type { Node as PMNode } from "@tiptap/pm/model";

/*
 * Maths in answers, as the lesson writes it (method.md, "Format"): `$…$` inline, `$$…$$` on a line
 * of its own, rendered with KaTeX as the learner types the closing dollar. Clicking a formula turns
 * it back into its text to edit; typing the closing dollar again renders it again.
 */

const KATEX = { throwOnError: false, trust: false };

/**
 * `$x$` just closed: neither dollar touching a space (so "$5 and $6" stays money), and not the
 * second dollar of `$$`.
 */
const INLINE = /(?<![$\\\w])\$([^$\s](?:[^$\n]*[^$\s\\])?)\$$/;
/** A paragraph that is only `$$…$$`. */
const BLOCK = /^\$\$([^$]+)\$\$$/;

/** Turns a formula back into its source text, the cursor at its end, to edit it. */
function unwrap(editor: Editor, node: PMNode, pos: number, fence: string) {
  const text = `${fence}${String(node.attrs.latex ?? "")}${fence}`;
  editor
    .chain()
    .focus()
    .command(({ tr, state }) => {
      const content = node.isBlock
        ? state.schema.nodes.paragraph?.create(null, state.schema.text(text))
        : state.schema.text(text);
      if (!content) return false;
      tr.replaceWith(pos, pos + node.nodeSize, content);
      return true;
    })
    .setTextSelection(pos + text.length + (node.isBlock ? 1 : 0))
    .run();
}

/** `$…$`: rendered once its closing dollar is typed; a click turns it back into text. */
export const AnswerInlineMath = InlineMath.extend({
  addOptions() {
    return { ...this.parent?.(), katexOptions: KATEX };
  },
  onCreate() {
    // Set here, where the editor is known; the node view reads it when it is clicked.
    this.options.onClick = (node, pos) => {
      if (this.editor.isEditable) unwrap(this.editor, node, pos, "$");
    };
  },
  addInputRules() {
    return [
      new InputRule({
        find: INLINE,
        handler: ({ state, range, match }) => {
          const latex = match[1];
          if (!latex) return null;
          state.tr.replaceWith(range.from, range.to, this.type.create({ latex }));
        },
      }),
    ];
  },
});

/** `$$…$$` on a line of its own, the same way. */
export const AnswerBlockMath = BlockMath.extend({
  addOptions() {
    return { ...this.parent?.(), katexOptions: { ...KATEX, displayMode: true } };
  },
  onCreate() {
    this.options.onClick = (node, pos) => {
      if (this.editor.isEditable) unwrap(this.editor, node, pos, "$$");
    };
  },
  addInputRules() {
    return [
      new InputRule({
        find: BLOCK,
        handler: ({ state, range, match }) => {
          const latex = match[1]?.trim();
          if (!latex) return null;
          const $from = state.doc.resolve(range.from);
          // The whole paragraph becomes the formula.
          state.tr.replaceWith($from.before(), $from.after(), this.type.create({ latex }));
        },
      }),
    ];
  },
});
