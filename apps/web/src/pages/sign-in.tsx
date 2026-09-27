import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import { CentredPage } from "./auth-layout";

export function SignInPage() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "failed">("idle");

  const send = async () => {
    setState("sending");
    const { error } = await authClient.signIn.magicLink({ email: email.trim(), callbackURL: "/" });
    setState(error ? "failed" : "sent");
  };

  if (state === "sent") {
    return (
      <CentredPage>
        <h1 className="font-serif text-xl font-semibold">Check your email</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          If {email.trim()} is invited, a sign-in link is on its way. It works once and expires
          soon.
        </p>
        <Button
          variant="link"
          className="mt-4 px-0"
          onClick={() => {
            setState("idle");
          }}
        >
          Use a different email
        </Button>
      </CentredPage>
    );
  }

  return (
    <CentredPage>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
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
        <Button type="submit" className="w-full" disabled={state === "sending" || !email.trim()}>
          {state === "sending" ? "Sending…" : "Send me a sign-in link"}
        </Button>
        {state === "failed" && (
          <p className="text-sm text-destructive">
            That didn&apos;t go through. Try again in a moment.
          </p>
        )}
        <p className="text-xs text-subtle-foreground">
          Grounded is invite-only. No password needed.
        </p>
      </form>
    </CentredPage>
  );
}
