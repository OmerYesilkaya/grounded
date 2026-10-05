import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/i18n";
import {
  api,
  PROVIDER_LABELS,
  type Credential,
  type ModelOptions,
  type ProviderId,
} from "@/lib/api";
import { CentredPage } from "./auth-layout";

export function KeySettingsPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const t = useT().account.key;
  const models = useQuery({
    queryKey: ["models"],
    queryFn: () => api<ModelOptions>("/api/models"),
  });
  const credential = useQuery({
    queryKey: ["credential"],
    queryFn: () => api<Credential | null>("/api/credentials"),
  });

  const [provider, setProvider] = useState<ProviderId | "">("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");

  const save = useMutation({
    mutationFn: () =>
      api<Credential>("/api/credentials", {
        method: "PUT",
        body: JSON.stringify({ provider, model, apiKey }),
      }),
    onSuccess: (saved) => {
      setApiKey("");
      queryClient.setQueryData(["credential"], saved);
      void navigate({ to: "/" });
    },
  });
  const changeModel = useMutation({
    mutationFn: (model: string) =>
      api<Credential>("/api/credentials", { method: "PATCH", body: JSON.stringify({ model }) }),
    onSuccess: (saved) => {
      queryClient.setQueryData(["credential"], saved);
    },
  });
  const remove = useMutation({
    mutationFn: () => api<undefined>("/api/credentials", { method: "DELETE" }),
    onSuccess: () => {
      queryClient.setQueryData(["credential"], null);
    },
  });

  const providers = (Object.keys(PROVIDER_LABELS) as ProviderId[]).filter(
    (p) => (models.data?.[p].length ?? 0) > 0,
  );
  const modelChoices = provider ? (models.data?.[provider] ?? []) : [];

  return (
    <CentredPage>
      <h1 className="font-serif text-xl font-semibold">{t.title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{t.intro}</p>

      {credential.data && (
        <form
          className="mt-5 flex items-center justify-between gap-3 rounded-lg border bg-card px-3 py-2.5 text-sm"
          aria-label={t.savedKey}
          onSubmit={(event) => {
            event.preventDefault();
          }}
        >
          <span className="flex min-w-0 items-center gap-2">
            <span>{PROVIDER_LABELS[credential.data.provider]}</span>
            <span className="text-muted-foreground">·</span>
            {/* The model switches on its own: the key stays, the next call runs on the new one. */}
            <Select
              value={credential.data.model}
              onValueChange={(value) => {
                if (value && value !== credential.data?.model) changeModel.mutate(value);
              }}
              disabled={changeModel.isPending}
            >
              <SelectTrigger size="sm" aria-label={t.model}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(models.data?.[credential.data.provider] ?? []).map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-muted-foreground">· …{credential.data.keyHint}</span>
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={remove.isPending}
            onClick={() => {
              remove.mutate();
            }}
          >
            {t.remove}
          </Button>
        </form>
      )}
      {changeModel.error && (
        <p className="mt-2 text-sm text-destructive">{changeModel.error.message}</p>
      )}

      <form
        className="mt-6 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <div className="space-y-2">
          <Label>{t.provider}</Label>
          <Select
            value={provider}
            onValueChange={(value) => {
              setProvider(value as ProviderId);
              setModel(models.data?.[value as ProviderId][0]?.id ?? "");
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder={t.chooseProvider} />
            </SelectTrigger>
            <SelectContent>
              {providers.map((p) => (
                <SelectItem key={p} value={p}>
                  {PROVIDER_LABELS[p]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>{t.model}</Label>
          <Select
            value={model}
            // Radix's hidden native select reports "" when the options swap; keep the chosen model.
            onValueChange={(value) => {
              if (value) setModel(value);
            }}
            disabled={!provider}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder={t.chooseModel} />
            </SelectTrigger>
            <SelectContent>
              {modelChoices.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="api-key">{t.apiKey}</Label>
          <Input
            id="api-key"
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(event) => {
              setApiKey(event.target.value);
            }}
          />
        </div>
        <Button
          type="submit"
          className="w-full"
          disabled={!provider || !model || !apiKey.trim() || save.isPending}
        >
          {save.isPending ? t.checking : credential.data ? t.replace : t.save}
        </Button>
        {save.error && <p className="text-sm text-destructive">{save.error.message}</p>}
      </form>
    </CentredPage>
  );
}
