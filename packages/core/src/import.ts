import { z } from "zod";

/*
 * What the one-time import of a track kept elsewhere asks a model for (design §10). The ledger's terms
 * and statuses are parsed without a model; the model only reads what needs reading (the map, the plan,
 * the open threads) and answers with the numbered terms' ids, so no term's wording can drift.
 * Ids are plain JSON numbers: integer bounds aren't accepted by every provider's structured outputs,
 * and the importer drops anything that isn't a listed id.
 */
const termId = z.number().describe("A term's number in the numbered term list.");

export const importReadingSchema = z.object({
  dependencies: z
    .array(
      z.object({
        term: termId,
        restsOn: z
          .array(termId)
          .describe("The terms this one rests on: what must be understood before it."),
      }),
    )
    .describe(
      "What rests on what, read from the map (an arrow A ──► B means B rests on A) and from the plan where it says so. Only terms that rest on something; real dependencies only.",
    ),
  arcs: z
    .array(
      z.object({
        title: z
          .string()
          .describe('The arc\'s title as the plan names it, with "closed" in it when it is.'),
        terms: z.array(termId).describe("The terms the arc teaches, in teaching order."),
      }),
    )
    .describe("The plan's arcs in teaching order, closed ones included."),
  fixItems: z
    .array(z.string())
    .describe(
      "Misconceptions still open, to re-test: from the plan's probe leaks and the open threads. Each one short, phrased as the belief itself, listed once. Closed ones are left out.",
    ),
  planNotes: z
    .string()
    .describe(
      "A few plain lines the tutor reads first: where the track stands, what comes next, reorders and detours. The state's own plan, threads and log are appended verbatim; don't repeat them.",
    ),
  unplaced: z
    .array(z.string())
    .describe(
      "Anything in the map or the plan that couldn't be expressed with the numbered terms, one short line each. Empty if everything was placed.",
    ),
});

export type ImportReading = z.infer<typeof importReadingSchema>;
