import { bare, refusal, type BareRefusalCode } from "@grounded/core";

/*
 * A refusal's body: `{ error: <notice> }`, a code the web words in the app's language (design
 * §9.3), with whatever else goes with it. Never words: the API says nothing in any language.
 */

/** A refusal that takes no values. */
export const refuse = (code: BareRefusalCode) => refusal(bare(code));

export const notFound = refuse("not-found");
