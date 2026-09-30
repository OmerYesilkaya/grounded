import type { ReactNode } from "react";
import { Brand } from "@/components/brand";
import { LanguageSwitch } from "@/components/language-switch";
import { useT } from "@/i18n";

/** A quiet centred frame for signed-out and setup pages, with the language to read them in. */
export function CentredPage({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <p className="mb-8 text-center">
          <Brand className="text-2xl" />
        </p>
        {children}
        <LanguageSwitch className="mt-10" />
      </div>
    </main>
  );
}

/** Design §12: what is stored, said plainly before anyone signs in. */
export function WhatIsStored() {
  return (
    <p className="mt-8 border-t pt-4 text-xs leading-relaxed text-subtle-foreground">
      {useT().account.signIn.whatIsStored}
    </p>
  );
}
