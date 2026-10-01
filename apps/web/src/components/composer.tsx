import { ArrowUp, Paperclip } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Button } from "@/components/ui/button";
import { LineEditor } from "@/editor/line-editor";
import { useT } from "@/i18n";
import { isTouchScreen } from "@/lib/media-query";
import { cn } from "@/lib/utils";

export interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  /** Called with the trimmed text; clearing `value` afterwards is up to the caller. */
  onSubmit: (text: string) => void;
  /** The textarea's accessible name. */
  label: string;
  /** The textarea's id, for a visible `<label htmlFor>` elsewhere on the page. */
  id?: string;
  /** The send button's accessible name; also its text unless `submitIcon` is set. */
  submitLabel: string;
  /** Show the send button as a round arrow, the way chat composers do. */
  submitIcon?: boolean;
  placeholder?: string;
  /** How many lines the box shows while empty (default 1). */
  minRows?: number;
  /**
   * enter (default): Enter sends, Shift+Enter starts a new line, as in chat. mod-enter: for longer
   * writing, Enter starts a new line and ⌘/Ctrl+Enter sends.
   */
  submitShortcut?: "enter" | "mod-enter";
  /** Neither editing nor sending. */
  disabled?: boolean;
  /** Editing stays open, sending is held back (e.g. while the last message is on its way). */
  submitDisabled?: boolean;
  /** Buttons shown before the send button, such as "I don't know". */
  actions?: ReactNode;
  /** Below the small breakpoint, stack the buttons full width (design §9.4). */
  stackActions?: boolean;
  /**
   * Accept files: an attach button, files dropped on the box and files pasted into it. What to do
   * with them (checking, listing, removing) is up to the caller.
   */
  onAddFiles?: (files: File[]) => void;
  /** For the file picker's `accept`. */
  accept?: string;
  /** Shown between the text and the buttons, such as the attached files. */
  attachments?: ReactNode;
  /**
   * Take focus when the composer opens, whenever it is enabled again, and whenever `focusKey`
   * changes, unless the learner is busy in another field or selecting text. A box that is off
   * screen at that moment waits until it is scrolled into view, so it never pulls the page down to
   * itself. On a touch screen, where focus brings up the keyboard over what is being read, only
   * with "always": for a box the learner has just tapped to open.
   */
  autoFocus?: boolean | "always";
  /** A new value (e.g. a fresh question arriving) is another moment to take focus. */
  focusKey?: string | number;
  /**
   * The one-line answer editor instead of a plain box (design §7.4): `code`, **bold** and `$…$`
   * maths as the learner types them, sent as markdown. For check answers and asides.
   */
  rich?: boolean;
  className?: string;
}

/**
 * The message box for the chat, for check answers and for a new track: grows with its content up
 * to a maximum height, then scrolls. Enter sends, Shift+Enter starts a new line (or, with
 * `submitShortcut="mod-enter"`, Enter starts a line and ⌘/Ctrl+Enter sends).
 *
 * A plain textarea, or with `rich` the one-line answer editor (Enter always sends there).
 */
export function Composer({
  value,
  onChange,
  onSubmit,
  label,
  id,
  submitLabel,
  submitIcon = false,
  placeholder,
  minRows = 1,
  submitShortcut = "enter",
  disabled = false,
  submitDisabled = false,
  actions,
  stackActions = false,
  onAddFiles,
  accept,
  attachments,
  autoFocus = false,
  focusKey,
  rich = false,
  className,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lineRef = useRef<HTMLElement>(null);
  const field = () => (rich ? lineRef.current : textareaRef.current);
  const pickerRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const t = useT().session;
  const acceptsFiles = onAddFiles !== undefined && !disabled;
  const canSubmit = !disabled && !submitDisabled && value.trim() !== "";

  useAutoHeight(textareaRef, value);

  useEffect(() => {
    const box = rich ? lineRef.current : textareaRef.current;
    if (!autoFocus || disabled || !box) return;
    // On a touch screen the learner taps the box when they are ready to write.
    if (autoFocus !== "always" && isTouchScreen()) return;
    // The page scrolls on its own terms (the lesson glides to a step a check has opened), and focus
    // would jump it: `preventScroll` holds the browser back, but the answer editor scrolls to its
    // caret as soon as it is focused. So a box off screen takes focus only once the learner has
    // scrolled down to it, where there is nothing left to scroll to.
    return whenOnScreen(box, () => {
      if (!busyElsewhere(box)) box.focus({ preventScroll: true });
    });
  }, [autoFocus, disabled, focusKey, rich]);

  /** Sends `text`: what the box holds, which the rich editor gives as it is this moment. */
  const submit = (text = value) => {
    if (!disabled && !submitDisabled && text.trim() !== "") onSubmit(text.trim());
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    if (submitShortcut === "mod-enter" && !(event.metaKey || event.ctrlKey)) return;
    // The Enter that confirms an IME composition (Japanese, Chinese, Korean…) is not a send.
    // Safari ends the composition before this keydown, so only the legacy keyCode 229 tells.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    submit();
  };

  const carriesFiles = (event: DragEvent) =>
    acceptsFiles && event.dataTransfer.types.includes("Files");
  const onDragOver = (event: DragEvent) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragging(true);
  };

  return (
    <form
      className={cn(
        "rounded-2xl border border-input bg-card text-foreground transition-colors focus-within:border-ring",
        dragging && "border-dashed border-ring bg-highlight",
        disabled && "opacity-60",
        className,
      )}
      onDragEnter={onDragOver}
      onDragOver={onDragOver}
      onDragLeave={(event) => {
        // Leaving for a child of the box is still over the box.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        setDragging(false);
        const files = [...event.dataTransfer.files];
        if (files.length) onAddFiles?.(files);
      }}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
        // Clicking send moved focus to the button; the next message starts in the box again.
        field()?.focus();
      }}
    >
      {rich ? (
        <LineEditor
          value={value}
          onChange={onChange}
          onEnter={submit}
          label={label}
          id={id}
          placeholder={placeholder}
          disabled={disabled}
          fieldRef={lineRef}
        />
      ) : (
        <textarea
          ref={textareaRef}
          id={id}
          aria-label={label}
          rows={minRows}
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(event) => {
            onChange(event.target.value);
          }}
          onKeyDown={onKeyDown}
          onPaste={(event) => {
            // A picture copied on its own arrives as a file; text (even with a picture) pastes as text.
            const files = [...event.clipboardData.files];
            if (!acceptsFiles || !files.length || event.clipboardData.getData("text/plain")) return;
            event.preventDefault();
            onAddFiles(files);
          }}
          className="block max-h-52 w-full resize-none overflow-y-auto bg-transparent px-4 pt-3 pb-1 text-[15px] leading-relaxed outline-none pointer-coarse:text-base placeholder:text-subtle-foreground disabled:cursor-not-allowed"
        />
      )}
      {attachments}
      <div
        className={cn(
          "flex items-center justify-end gap-2 px-2.5 pb-2.5",
          stackActions && "max-sm:flex-col max-sm:items-stretch max-sm:pt-1.5",
        )}
      >
        {onAddFiles && (
          <>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t.attachFiles}
              title={t.attachFiles}
              disabled={disabled}
              className="mr-auto rounded-full text-muted-foreground"
              onClick={() => pickerRef.current?.click()}
            >
              <Paperclip />
            </Button>
            <input
              ref={pickerRef}
              type="file"
              multiple
              accept={accept}
              hidden
              onChange={(event) => {
                const files = [...(event.target.files ?? [])];
                // The same file can be picked again after it is removed.
                event.target.value = "";
                if (files.length) onAddFiles(files);
              }}
            />
          </>
        )}
        {actions}
        {submitIcon ? (
          <Button
            type="submit"
            size="icon-sm"
            aria-label={submitLabel}
            disabled={!canSubmit}
            className="rounded-full"
          >
            <ArrowUp />
          </Button>
        ) : (
          <Button
            type="submit"
            size="sm"
            disabled={!canSubmit}
            className={cn(stackActions && "max-sm:h-11 max-sm:text-[15px]")}
          >
            {submitLabel}
          </Button>
        )}
      </div>
    </form>
  );
}

/** The learner is typing in another field, or selecting text (to ask about it, say). */
/**
 * Calls `then` once `element` is (or comes) on screen, and returns what stops waiting. Where the
 * browser can't tell (tests), it is on screen now.
 */
function whenOnScreen(element: HTMLElement, then: () => void): () => void {
  if (typeof IntersectionObserver === "undefined") {
    then();
    return () => undefined;
  }
  const observer = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    observer.disconnect();
    then();
  });
  observer.observe(element);
  return () => {
    observer.disconnect();
  };
}

function busyElsewhere(box: HTMLElement): boolean {
  const active = document.activeElement;
  if (
    active !== box &&
    (active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement ||
      active instanceof HTMLSelectElement ||
      (active instanceof HTMLElement && active.isContentEditable))
  ) {
    return true;
  }
  const selection = document.getSelection();
  return selection !== null && !selection.isCollapsed;
}

/**
 * Sizes the textarea to its content; the CSS max-height caps it, and past that it scrolls.
 * (CSS `field-sizing: content` would do this, but Firefox doesn't support it yet.)
 */
function useAutoHeight(ref: RefObject<HTMLTextAreaElement | null>, value: string): void {
  useLayoutEffect(() => {
    const textarea = ref.current;
    if (!textarea) return;
    const fit = () => {
      textarea.style.height = "auto";
      textarea.style.height = `${String(textarea.scrollHeight)}px`;
    };
    fit();
    // Line wrapping, and so the height, changes with the width.
    window.addEventListener("resize", fit);
    return () => {
      window.removeEventListener("resize", fit);
    };
  }, [ref, value]);
}
