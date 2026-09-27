import { ArrowUp } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  /** Called with the trimmed text; clearing `value` afterwards is up to the caller. */
  onSubmit: (text: string) => void;
  /** The textarea's accessible name. */
  label: string;
  /** The send button's accessible name; also its text unless `submitIcon` is set. */
  submitLabel: string;
  /** Show the send button as a round arrow, the way chat composers do. */
  submitIcon?: boolean;
  placeholder?: string;
  /** Neither editing nor sending. */
  disabled?: boolean;
  /** Editing stays open, sending is held back (e.g. while the last message is on its way). */
  submitDisabled?: boolean;
  /** Buttons shown before the send button, such as "I don't know". */
  actions?: ReactNode;
  /** Below the small breakpoint, stack the buttons full width (design §9.4). */
  stackActions?: boolean;
  /**
   * Take focus when the composer opens, whenever it is enabled again, and whenever `focusKey`
   * changes, unless the learner is busy in another field or selecting text.
   */
  autoFocus?: boolean;
  /** A new value (e.g. a fresh question arriving) is another moment to take focus. */
  focusKey?: string | number;
  className?: string;
}

/**
 * The message box for the chat and for check answers: grows with its content up to a maximum
 * height, then scrolls. Enter sends, Shift+Enter starts a new line.
 *
 * A plain textarea for now; answers move to a Tiptap editor with homework (design §7.4, step 7).
 */
export function Composer({
  value,
  onChange,
  onSubmit,
  label,
  submitLabel,
  submitIcon = false,
  placeholder,
  disabled = false,
  submitDisabled = false,
  actions,
  stackActions = false,
  autoFocus = false,
  focusKey,
  className,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const canSubmit = !disabled && !submitDisabled && value.trim() !== "";

  useAutoHeight(textareaRef, value);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!autoFocus || disabled || !textarea || busyElsewhere(textarea)) return;
    // The page scrolls on its own terms (the lesson glides to a new step); focus must not jump it.
    textarea.focus({ preventScroll: true });
  }, [autoFocus, disabled, focusKey]);

  const submit = () => {
    if (canSubmit) onSubmit(value.trim());
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    // The Enter that confirms an IME composition (Japanese, Chinese, Korean…) is not a send.
    // Safari ends the composition before this keydown, so only the legacy keyCode 229 tells.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    submit();
  };

  return (
    <form
      className={cn(
        "rounded-2xl border border-input bg-card text-foreground transition-colors focus-within:border-ring",
        disabled && "opacity-60",
        className,
      )}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
        // Clicking send moved focus to the button; the next message starts in the box again.
        textareaRef.current?.focus();
      }}
    >
      <textarea
        ref={textareaRef}
        aria-label={label}
        rows={1}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        onKeyDown={onKeyDown}
        className="block max-h-52 w-full resize-none overflow-y-auto bg-transparent px-4 pt-3 pb-1 text-[15px] leading-relaxed outline-none placeholder:text-subtle-foreground disabled:cursor-not-allowed"
      />
      <div
        className={cn(
          "flex items-center justify-end gap-2 px-2.5 pb-2.5",
          stackActions && "max-sm:flex-col max-sm:items-stretch max-sm:pt-1.5",
        )}
      >
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
          <Button type="submit" size="sm" disabled={!canSubmit}>
            {submitLabel}
          </Button>
        )}
      </div>
    </form>
  );
}

/** The learner is typing in another field, or selecting text (to ask about it, say). */
function busyElsewhere(textarea: HTMLTextAreaElement): boolean {
  const active = document.activeElement;
  if (
    active !== textarea &&
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
