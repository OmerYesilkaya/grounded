import type { ReactNode } from "react";

/** A quiet centred frame for signed-out and setup pages. */
export function CentredPage({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <p className="mb-8 text-center font-serif text-2xl font-semibold tracking-tight">
          Grounded
        </p>
        {children}
      </div>
    </main>
  );
}
