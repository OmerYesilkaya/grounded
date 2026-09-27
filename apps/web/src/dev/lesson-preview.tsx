import { parseBlocks, parseLesson } from "@grounded/content";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ContentProvider, type Theme } from "@/content/environment";
import { LessonView, type StepProgress } from "@/lesson/lesson-view";
import { FIXTURE_LESSON } from "./fixture-lesson";

const lesson = parseLesson(FIXTURE_LESSON);
const tutor = (markdown: string, verdict?: "landed" | "missed") => ({
  from: "tutor" as const,
  blocks: parseBlocks(markdown).blocks,
  ...(verdict ? { verdict } : {}),
});

/**
 * Dev-only preview of the lesson view with a fake grader: the first answer on step 2 misses and gets
 * a repair; "I don't know" twice offers the pause / continue choice; everything else lands.
 */
export function LessonPreview() {
  const [theme, setTheme] = useState<Theme>("dark");
  const [progress, setProgress] = useState<Record<string, StepProgress>>({});
  const [misses, setMisses] = useState<Record<string, number>>({});

  const update = (stepId: string, change: (p: StepProgress) => StepProgress) => {
    setProgress((all) => ({
      ...all,
      [stepId]: change(all[stepId] ?? { status: "open", thread: [] }),
    }));
  };
  const grade = (stepId: string, text: string | null) => {
    update(stepId, (p) => ({
      ...p,
      grading: true,
      thread: [...p.thread, { from: "learner", text: text ?? "I don't know" }],
    }));
    window.setTimeout(() => {
      const missed = misses[stepId] ?? 0;
      if (text === null || (stepId === "s2" && missed === 0)) {
        setMisses((m) => ({ ...m, [stepId]: missed + 1 }));
        update(stepId, (p) => ({
          ...p,
          grading: false,
          offerGate: text === null && missed >= 1,
          ...(stepId === "s2"
            ? {
                note: "The second worker copied the value out before the first put its result back, so it worked from a stale copy.",
              }
            : {}),
          thread: [
            ...p.thread,
            tutor(
              stepId === "s2"
                ? "Close, but that describes what happened, not why. Worker B copied the value out **before** worker A put its 6 back, so B was adding one to a stale 5."
                : "Thanks, that's useful to know. Think about which value each worker is holding at the moment it puts its result back.",
              "missed",
            ),
            tutor(
              "**Try this one:** two workers each take 1 away from a balance of 10 at the same time, using the same three moves. What is the worst final value, and why?",
            ),
          ],
        }));
        return;
      }
      update(stepId, (p) => ({
        ...p,
        grading: false,
        status: "passed",
        thread: [
          ...p.thread,
          tutor("Yes — each works from a copy that is already out of date.", "landed"),
        ],
      }));
    }, 900);
  };

  return (
    <ContentProvider theme={theme}>
      <div className="sticky top-0 z-10 flex h-13 items-center justify-between border-b bg-background/90 px-4 backdrop-blur">
        <span className="font-sans text-sm text-muted-foreground">Dev preview · lesson view</span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            const next = theme === "dark" ? "light" : "dark";
            document.documentElement.dataset.theme = next;
            setTheme(next);
          }}
        >
          {theme === "dark" ? "Light" : "Dark"}
        </Button>
      </div>
      {lesson.issues.length > 0 && (
        <pre className="p-4 text-destructive">{JSON.stringify(lesson.issues, null, 2)}</pre>
      )}
      <LessonView
        steps={lesson.steps}
        totalSteps={5}
        progress={progress}
        onAnswer={(id, text) => {
          grade(id, text);
        }}
        onDontKnow={(id) => {
          grade(id, null);
        }}
        onPause={(id) => {
          update(id, (p) => ({ ...p, status: "paused", offerGate: false }));
        }}
        onContinue={(id) => {
          update(id, (p) => ({ ...p, status: "settling", offerGate: false }));
        }}
      />
    </ContentProvider>
  );
}
