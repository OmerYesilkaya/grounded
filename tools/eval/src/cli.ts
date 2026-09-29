import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";
import { parseArgs } from "node:util";

/*
 * pnpm eval [--persona <id>]… [--model <id>] [--method <path>] [--runs <n>] [--concurrency <n>]
 *           [--learner-model <id>] [--judge-model <id>] [--no-judge] [--demo] [--keep-db]
 *
 * Runs whole sessions of the real app with a model playing each persona, then scores them
 * (design §11). Every run gets a database of its own on DATABASE_URL's server (EVAL_DATABASE_URL to
 * use another) and writes its transcript and report to tools/eval/results/.
 */

// The app's logs would drown the progress lines; LOG_LEVEL still wins when set.
process.env.LOG_LEVEL ??= "warn";

const { values } = parseArgs({
  options: {
    persona: { type: "string", multiple: true },
    model: { type: "string", default: "claude-opus-5-5" },
    method: { type: "string" },
    runs: { type: "string", default: "1" },
    concurrency: { type: "string", default: "2" },
    "learner-model": { type: "string", default: "claude-opus-5-5" },
    "judge-model": { type: "string", default: "claude-opus-5-5" },
    "no-judge": { type: "boolean", default: false },
    demo: { type: "boolean", default: false },
    "keep-db": { type: "boolean", default: false },
  },
});

const { parseMethod } = await import("@grounded/core");
const { createLanguageModel, findModel } = await import("@grounded/providers");
const { loadPersona, personaIds } = await import("./persona.js");
const { runEval } = await import("./run.js");
const { summaryLine, writeRun } = await import("./report.js");
type Candidate = import("./run.js").Candidate;
type ProviderId = import("@grounded/providers").ProviderId;

const KEY_ENV: Record<ProviderId, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
};

function modelFor(id: string) {
  const entry = findModel(id);
  if (!entry) throw new Error(`"${id}" isn't on the model list (packages/providers/src/models.ts)`);
  const apiKey = process.env[KEY_ENV[entry.provider]];
  if (!apiKey) throw new Error(`${KEY_ENV[entry.provider]} is needed for ${id}`);
  return { provider: entry.provider, model: id, apiKey };
}

const serverUrl = process.env.EVAL_DATABASE_URL ?? process.env.DATABASE_URL;
if (!serverUrl) throw new Error("DATABASE_URL (or EVAL_DATABASE_URL) is needed");

const candidate: Candidate = values.demo
  ? { kind: "demo" }
  : { kind: "model", ...modelFor(values.model) };
const learnerSpec = modelFor(values["learner-model"]);
const learner = createLanguageModel(learnerSpec.provider, learnerSpec.model, learnerSpec.apiKey);
const judgeSpec = values["no-judge"] ? null : modelFor(values["judge-model"]);
const judgeModel = judgeSpec
  ? createLanguageModel(judgeSpec.provider, judgeSpec.model, judgeSpec.apiKey)
  : undefined;

let method: { method: import("@grounded/core").Method; label: string } | undefined;
if (values.method) {
  const path = resolve(process.env.INIT_CWD ?? process.cwd(), values.method);
  const text = readFileSync(path, "utf8");
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 8);
  method = { method: parseMethod(text), label: `${relative(resolve("../.."), path)}@${hash}` };
}

const personas = values.persona?.length ? values.persona : personaIds();
const jobs = personas.flatMap((id) =>
  Array.from({ length: Number(values.runs) }, () => loadPersona(id)),
);
console.log(
  `${String(jobs.length)} run(s): ${personas.join(", ")} · tutor ${candidate.kind === "demo" ? "demo" : candidate.model} · method ${method?.label ?? "method.md"} · learner ${learnerSpec.model} · judge ${judgeSpec?.model ?? "none"}`,
);

const lines: string[] = [];
let next = 0;
const worker = async () => {
  for (let job = jobs[next++]; job; job = jobs[next++]) {
    const persona = job;
    const result = await runEval({
      persona,
      candidate,
      ...(method ? { method } : {}),
      learner,
      ...(judgeModel ? { judgeModel } : {}),
      serverUrl,
      keepDatabase: values["keep-db"],
      onProgress: (line) => {
        console.log(`  [${persona.id}] ${line.replace(/\s+/g, " ").slice(0, 160)}`);
      },
    });
    const dir = writeRun(result);
    const line = summaryLine(result);
    lines.push(line);
    console.log(`${line}\n  → ${dir}`);
  }
};
await Promise.all(Array.from({ length: Math.max(1, Number(values.concurrency)) }, worker));
console.log(`\nSummary\n${lines.map((l) => `- ${l}`).join("\n")}`);
process.exit(0);
