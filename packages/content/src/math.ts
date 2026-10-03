import { mathFromMarkdown } from "mdast-util-math";
import { math } from "micromark-extension-math";
import { asciiDigit, markdownLineEnding, markdownSpace } from "micromark-util-character";
import { codes } from "micromark-util-symbol";
import type { Code, Construct, Extension, State, Token, Tokenizer } from "micromark-util-types";
import type { Processor } from "unified";

/*
 * Maths as the method writes it: `$…$` inline, `$$…$$` on a line of its own (remark-math's syntax),
 * except that a single dollar is money unless it hugs its formula, the rule the answer editor uses
 * (`apps/web/src/editor/math.ts`) and Pandoc's: `$` opens only before a character that isn't a
 * space, and closes only after one that isn't a space and before one that isn't a digit. So
 * "100$ in a year becomes 10$" and "$5 and then $6" stay text, and `$x$` is still a formula. A
 * single-dollar formula also holds no dollar of its own unless escaped (`\$`), as in TeX, so the
 * money in "$100 grows to $110, that is $100 \cdot 1.1$" stays text before the formula.
 * `$$…$$` within a line keeps remark-math's rule.
 */

const dollar = math();
const original = dollar.text?.[codes.dollarSign] as Construct;

/** A space, tab or line ending, or nothing at all: what a single dollar may not hug. */
function blank(code: Code): boolean {
  return code === codes.eof || markdownSpace(code) || markdownLineEnding(code);
}

/** remark-math's inline tokenizer with the money rule for single dollars. */
const tokenizeMathText: Tokenizer = function (effects, ok, nok) {
  let sizeOpen = 0;
  let size = 0;
  let token: Token | undefined;
  /** The last character inside the formula, which a closing single dollar may not follow if blank. */
  let last: Code = codes.eof;
  /** Whether the formula so far ends in an odd run of backslashes, escaping a dollar after it. */
  let escaping = false;

  const start: State = (code) => {
    effects.enter("mathText");
    effects.enter("mathTextSequence");
    return sequenceOpen(code);
  };

  const sequenceOpen: State = (code) => {
    if (code === codes.dollarSign) {
      effects.consume(code);
      sizeOpen++;
      return sequenceOpen;
    }
    if (sizeOpen === 1 && blank(code)) return nok(code);
    effects.exit("mathTextSequence");
    return between(code);
  };

  const between: State = (code) => {
    if (code === codes.eof) return nok(code);
    if (code === codes.dollarSign) {
      token = effects.enter("mathTextSequence");
      size = 0;
      return sequenceClose(code);
    }
    if (code === codes.space) {
      effects.enter("space");
      effects.consume(code);
      effects.exit("space");
      escaping = false;
      last = code;
      return between;
    }
    if (markdownLineEnding(code)) {
      effects.enter("lineEnding");
      effects.consume(code);
      effects.exit("lineEnding");
      escaping = false;
      last = code;
      return between;
    }
    effects.enter("mathTextData");
    return data(code);
  };

  const data: State = (code) => {
    const escaped = code === codes.dollarSign && sizeOpen === 1 && escaping;
    if (
      code === codes.eof ||
      code === codes.space ||
      (code === codes.dollarSign && !escaped) ||
      markdownLineEnding(code)
    ) {
      effects.exit("mathTextData");
      return between(code);
    }
    effects.consume(code);
    escaping = code === codes.backslash && !escaping;
    last = code;
    return data;
  };

  const sequenceClose: State = (code) => {
    if (code === codes.dollarSign) {
      effects.consume(code);
      size++;
      return sequenceClose;
    }
    const closes = size === sizeOpen && (sizeOpen > 1 || (!blank(last) && !asciiDigit(code)));
    if (closes) {
      effects.exit("mathTextSequence");
      effects.exit("mathText");
      return ok(code);
    }
    // A single dollar that doesn't close is money, and so was the opening one.
    if (sizeOpen === 1) return nok(code);
    // Not this formula's closing: the dollars are part of it.
    if (token) token.type = "mathTextData";
    last = codes.dollarSign;
    return data(code);
  };

  return start;
};

const mathText: Construct = { ...original, tokenize: tokenizeMathText };

const syntax: Extension = { ...dollar, text: { [codes.dollarSign]: mathText } };

/** Maths in markdown, single dollars left as money (see above). Parsing only. */
export function remarkMath(this: Processor): undefined {
  const data = this.data();
  (data.micromarkExtensions ??= []).push(syntax);
  (data.fromMarkdownExtensions ??= []).push(mathFromMarkdown());
}
