import { parseBlocks, parseLesson } from "@grounded/content";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ContentProvider } from "@/content/environment";
import { LessonView, type Aside, type LessonAsides, type StepProgress } from "@/lesson/lesson-view";
import { setThemeChoice, useTheme } from "@/lib/theme";
import { FIXTURE_LESSON } from "./fixture-lesson";

const lesson = parseLesson(FIXTURE_LESSON);
const tutor = (markdown: string, verdict?: "landed" | "missed") => ({
  from: "tutor" as const,
  blocks: parseBlocks(markdown).blocks,
  ...(verdict ? { verdict } : {}),
});

const ANSWERS = [
  "The number itself never moves: it stays in memory the whole time. What changes is a **copy** of it, held by the part that does the arithmetic, and only the last move puts the new value back.",
  "Yes, and it isn't only a problem for programs on one machine: databases meet it all the time, with many people changing the same row. That's a story of its own; we can save it for a future session.",
];

/** Asides answered by a stand-in that streams canned answers; every second one offers a tangent. */
function useFakeAsides(): LessonAsides {
  const [items, setItems] = useState<Aside[]>([]);
  const count = useRef(0);
  const change = (id: string, update: (aside: Aside) => Aside) => {
    setItems((all) => all.map((a) => (a.id === id ? update(a) : a)));
  };
  const answer = (id: string) => {
    const text = ANSWERS[count.current++ % ANSWERS.length] ?? "";
    let at = 0;
    const timer = window.setInterval(() => {
      at = Math.min(text.length, at + 14);
      change(id, (a) => ({ ...a, draft: text.slice(0, at) }));
      if (at < text.length) return;
      window.clearInterval(timer);
      const offers = count.current % 2 === 0;
      change(id, (a) => ({
        ...a,
        draft: null,
        tangent: offers ? "How databases keep updates from getting lost" : a.tangent,
        messages: [
          ...a.messages,
          {
            id: `${id}-${String(a.messages.length)}`,
            role: "tutor",
            text,
            blocks: parseBlocks(text).blocks,
          },
        ],
      }));
    }, 60);
  };
  return {
    items,
    hint: items.length === 0,
    canAsk: true,
    onAsk: (anchor, text) => {
      const id = `aside-${String(Date.now())}`;
      window.setTimeout(() => {
        setItems((all) => [
          ...all,
          {
            id,
            stepId: anchor.blockId.split(".")[0] ?? "s1",
            anchor,
            messages: [{ id: `${id}-0`, role: "learner", text, blocks: null }],
            draft: "",
            tangent: null,
            saved: false,
          },
        ]);
        window.setTimeout(() => {
          answer(id);
        }, 700);
      }, 150);
      return Promise.resolve(id);
    },
    onFollowUp: (id, text) => {
      change(id, (a) => ({
        ...a,
        draft: "",
        messages: [
          ...a.messages,
          { id: `${id}-${String(a.messages.length)}`, role: "learner", text, blocks: null },
        ],
      }));
      window.setTimeout(() => {
        answer(id);
      }, 700);
      return Promise.resolve();
    },
    onSave: (id) => {
      change(id, (a) => ({ ...a, saved: true }));
    },
  };
}

/**
 * Dev-only preview of the lesson view with a fake grader: the first answer on step 2 misses and gets
 * a repair; "I don't know" twice offers the pause / continue choice; everything else lands. Asides
 * are answered by a stand-in.
 */
export function LessonPreview() {
  const theme = useTheme();
  const [progress, setProgress] = useState<Record<string, StepProgress>>({});
  const [misses, setMisses] = useState<Record<string, number>>({});
  const asides = useFakeAsides();

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
    <ContentProvider>
      <div className="sticky top-0 z-10 flex h-13 items-center justify-between border-b bg-background/90 px-4 backdrop-blur">
        <span className="font-sans text-sm text-muted-foreground">Dev preview · lesson view</span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setThemeChoice(theme === "dark" ? "light" : "dark");
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
        asides={asides}
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
