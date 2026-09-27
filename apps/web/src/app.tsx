import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { queryClient, router } from "./router";

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
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
