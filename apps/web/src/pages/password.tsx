import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/i18n";
import { ApiError } from "@/lib/api";
import { setPassword } from "@/lib/auth";
import { CentredPage } from "./auth-layout";

/**
 * Choosing the password on the first visit, which ends the invite code, and changing it later
 * from the account menu, which takes the current one (design §4.3). The new one is typed twice:
 * a typo here would otherwise cost a new invite code.
 */
export function PasswordPage({ change, onDone }: { change: boolean; onDone: () => void }) {
  const t = useT();
  const words = t.account.password;
  const [current, setCurrent] = useState("");
  const [password, setNew] = useState("");
  const [repeat, setRepeat] = useState("");
  const [state, setState] = useState<
    { kind: "idle" | "saving" } | { kind: "failed"; message: string }
  >({ kind: "idle" });

  const complete = password.length > 0 && repeat.length > 0 && (!change || current.length > 0);

  const submit = async () => {
    if (password !== repeat) {
      setState({ kind: "failed", message: words.differ });
      return;
    }
    setState({ kind: "saving" });
    try {
      await setPassword(password, change ? current : undefined);
      onDone();
    } catch (error) {
      setState({
        kind: "failed",
        message: error instanceof ApiError && error.notice ? error.message : t.common.failedMoment,
      });
    }
  };

  return (
    <CentredPage>
      <h1 className="font-serif text-xl font-semibold">
        {change ? words.changeTitle : words.chooseTitle}
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {change ? words.changeIntro : words.chooseIntro}
      </p>
      <form
        className="mt-6 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {change && (
          <div className="space-y-2">
            <Label htmlFor="current-password">{words.current}</Label>
            <Input
              id="current-password"
              type="password"
              autoComplete="current-password"
              required
              value={current}
              onChange={(event) => {
                setCurrent(event.target.value);
              }}
            />
          </div>
        )}
        <div className="space-y-2">
          <Label htmlFor="new-password">{words.new}</Label>
          <Input
            id="new-password"
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(event) => {
              setNew(event.target.value);
            }}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="repeat-password">{words.repeat}</Label>
          <Input
            id="repeat-password"
            type="password"
            autoComplete="new-password"
            required
            value={repeat}
            onChange={(event) => {
              setRepeat(event.target.value);
            }}
          />
        </div>
        <Button type="submit" className="w-full" disabled={state.kind === "saving" || !complete}>
          {state.kind === "saving" ? words.saving : words.save}
        </Button>
        {state.kind === "failed" && <p className="text-sm text-destructive">{state.message}</p>}
      </form>
    </CentredPage>
  );
}
