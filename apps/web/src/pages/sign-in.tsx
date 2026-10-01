import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/i18n";
import { ApiError } from "@/lib/api";
import { signIn } from "@/lib/auth";
import { CentredPage, WhatIsStored } from "./auth-layout";

/** Sign-in is the invited email and the invite code handed over with it (design §4.3). */
export function SignInPage({ onSignedIn }: { onSignedIn: () => void }) {
  const t = useT();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [state, setState] = useState<
    { kind: "idle" | "sending" } | { kind: "failed"; message: string }
  >({ kind: "idle" });

  const submit = async () => {
    setState({ kind: "sending" });
    try {
      await signIn(email.trim(), code.trim());
      onSignedIn();
    } catch (error) {
      setState({
        kind: "failed",
        message:
          error instanceof ApiError && error.status === 403 ? error.message : t.common.failedMoment,
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
          <Label htmlFor="email">{t.account.signIn.email}</Label>
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
        <div className="space-y-2">
          <Label htmlFor="code">{t.account.signIn.code}</Label>
          <Input
            id="code"
            autoComplete="one-time-code"
            autoCapitalize="none"
            spellCheck={false}
            required
            value={code}
            onChange={(event) => {
              setCode(event.target.value);
            }}
          />
        </div>
        <Button
          type="submit"
          className="w-full"
          disabled={state.kind === "sending" || !email.trim() || !code.trim()}
        >
          {state.kind === "sending" ? t.account.signIn.signingIn : t.account.signIn.signIn}
        </Button>
        {state.kind === "failed" && <p className="text-sm text-destructive">{state.message}</p>}
        <p className="text-xs text-subtle-foreground">{t.account.signIn.inviteOnly}</p>
      </form>
      <WhatIsStored />
    </CentredPage>
  );
}
