import { Button } from "@/components/ui/button";
import { CentredPage, WhatIsStored } from "./auth-layout";

export interface InviteSearch {
  token?: string;
  email?: string;
  /** Set by the verify endpoint when it sends the person back here: the token was gone. */
  error?: string;
}

/** Where the button sends the browser: Better Auth's verify endpoint, which sets the session. */
export function verifyUrl(token: string): string {
  const params = new URLSearchParams({ token, callbackURL: "/", errorCallbackURL: "/invite" });
  return `/api/auth/magic-link/verify?${params.toString()}`;
}

const goTo = (url: string) => {
  window.location.assign(url);
};

/**
 * An invite link's landing page. Nothing is spent by opening it; the sign-in happens on the
 * button's click, as a full navigation so the cookie lands in this browser.
 */
export function InvitePage({
  token,
  email,
  error,
  navigate = goTo,
}: InviteSearch & { navigate?: (url: string) => void }) {
  if (error !== undefined || !token) {
    return (
      <CentredPage>
        <h1 className="font-serif text-xl font-semibold">This link has been used or has expired</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          An invite link works once, for a week. If you already signed in with it, open Grounded in
          that browser. Otherwise ask for a new link, or request one by email if you were invited.
        </p>
        <Button asChild variant="link" className="mt-4 px-0">
          <a href="/sign-in">Request a sign-in link by email</a>
        </Button>
      </CentredPage>
    );
  }
  return (
    <CentredPage>
      <h1 className="font-serif text-xl font-semibold">You&apos;re invited to Grounded</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        This link signs you in{email ? ` as ${email}` : ""}. It works once, so use it in the browser
        you&apos;ll keep using.
      </p>
      <Button
        className="mt-4 w-full"
        onClick={() => {
          navigate(verifyUrl(token));
        }}
      >
        Sign in
      </Button>
      <WhatIsStored />
    </CentredPage>
  );
}
