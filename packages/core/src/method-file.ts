import { readFileSync } from "node:fs";
import { parseMethod, type Method } from "./prompt.js";

let cached: Method | undefined;

/** The repo's method.md, parsed once. */
export function loadMethod(): Method {
  cached ??= parseMethod(readFileSync(new URL("../../../method.md", import.meta.url), "utf8"));
  return cached;
}
