import type { ReactNode } from "react";
import { Brand } from "@/components/brand";

/** A quiet centred frame for signed-out and setup pages. */
export function CentredPage({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <p className="mb-8 text-center">
          <Brand className="text-2xl" />
        </p>
        {children}
      </div>
    </main>
  );
}
