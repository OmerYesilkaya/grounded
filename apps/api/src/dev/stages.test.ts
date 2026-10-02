import { describe, expect, it } from "vitest";
import { createTestHarness } from "../test/harness.js";
import type { TrackSummary } from "../track-list.js";
import { seedStages, STAGES, stageModels } from "./stages.js";

const models = stageModels();
const t = createTestHarness({ models: models.access });

describe("the stages seed", () => {
  it("leaves a track at each stage", async () => {
    const seeded = await seedStages(t, models, {
      email: "stages@example.com",
      password: "stages-password",
    });
    expect(seeded.map((s) => s.key)).toEqual(STAGES.map((s) => s.key));
    const cookie = await t.signIn("stages@example.com");
    const list = (await (await t.request("/api/tracks", { cookie })).json()) as TrackSummary[];
    const track = (key: string) => {
      const id = seeded.find((s) => s.key === key)?.trackId;
      return list.find((x) => x.id === id);
    };
    const assignment = async (key: string) => {
      const path = seeded.find((s) => s.key === key)?.path ?? "";
      const id = path.replace("/homework/", "");
      return (await (await t.request(`/api/assignments/${id}`, { cookie })).json()) as {
        kind: string;
        submittedAt: string | null;
        tasks: { form: string }[];
        review: { status: string; comments: unknown[] } | null;
      };
    };

    expect(await assignment("homework-open")).toMatchObject({
      kind: "homework",
      submittedAt: null,
      review: null,
    });
    const homework = await assignment("homework-reviewed");
    expect(homework.review).toMatchObject({ status: "done" });
    expect(homework.review?.comments).toHaveLength(2);
    const open = await assignment("exam-open");
    expect(open).toMatchObject({ kind: "exam", submittedAt: null });
    expect(open.tasks.map((x) => x.form)).toEqual(["predict", "derivation", "build", "explain"]);
    expect((await assignment("exam-reviewed")).review).toMatchObject({ status: "done" });
    expect(track("exam-reviewed")?.final).toBe("ready");
    expect(track("final-teach-back")?.openSession).not.toBeNull();
    expect(track("final-finished")?.final).toBe("finished");
  }, 120_000);
});
