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

/** Design §12: what is stored, said plainly before anyone signs in. */
export function WhatIsStored() {
  return (
    <p className="mt-8 border-t pt-4 text-xs leading-relaxed text-subtle-foreground">
      What is stored: your answers, your progress, the questions you ask, the files you attach and
      your API key, encrypted. Nothing is shared; the tutor&apos;s calls go to the AI provider whose
      key you bring. Whoever runs Grounded can technically access the database, but does not read
      it.
    </p>
  );
}
