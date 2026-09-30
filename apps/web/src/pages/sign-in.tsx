import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError } from "@/lib/api";
import { signIn } from "@/lib/auth";
import { CentredPage, WhatIsStored } from "./auth-layout";

/** Sign-in is the invited email, nothing else (design §4.3). */
export function SignInPage({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<
    { kind: "idle" | "sending" } | { kind: "failed"; message: string }
  >({ kind: "idle" });

  const submit = async () => {
    setState({ kind: "sending" });
    try {
      await signIn(email.trim());
      onSignedIn();
    } catch (error) {
      setState({
        kind: "failed",
        message:
          error instanceof ApiError && error.status === 403
            ? error.message
            : "That didn't go through. Try again in a moment.",
      });
    }
  };

  return (
    <CentredPage>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
          />
        </div>
        <Button
          type="submit"
          className="w-full"
          disabled={state.kind === "sending" || !email.trim()}
        >
          {state.kind === "sending" ? "Signing in…" : "Sign in"}
        </Button>
        {state.kind === "failed" && <p className="text-sm text-destructive">{state.message}</p>}
        <p className="text-xs text-subtle-foreground">
          Grounded is invite-only: enter the email you were invited with. No password needed.
        </p>
      </form>
      <WhatIsStored />
    </CentredPage>
  );
}
