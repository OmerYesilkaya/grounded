import { LessonPreview } from "./dev/lesson-preview";

export function App() {
  if (import.meta.env.DEV && window.location.pathname === "/dev/lesson") return <LessonPreview />;
  return <main className="p-10 font-serif text-lg">Grounded</main>;
}
