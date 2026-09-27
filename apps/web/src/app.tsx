import { lazy, Suspense } from "react";

// Dev-only; the dynamic import is dropped from production builds with the DEV branch.
const LessonPreview = import.meta.env.DEV
  ? lazy(() => import("./dev/lesson-preview").then((m) => ({ default: m.LessonPreview })))
  : null;

export function App() {
  if (LessonPreview && window.location.pathname === "/dev/lesson") {
    return (
      <Suspense>
        <LessonPreview />
      </Suspense>
    );
  }
  return <main className="p-10 font-serif text-lg">Grounded</main>;
}
