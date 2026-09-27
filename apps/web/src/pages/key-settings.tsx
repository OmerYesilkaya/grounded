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
      <h1 className="font-serif text-xl font-semibold">Your AI key</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Lessons run on your own provider account. The key is encrypted and never shown again.
      </p>

      {credential.data && (
        <div className="mt-5 flex items-center justify-between rounded-lg border bg-card px-3 py-2.5 text-sm">
          <span>
            {PROVIDER_LABELS[credential.data.provider]} · {credential.data.model} ·{" "}
            <span className="text-muted-foreground">…{credential.data.keyHint}</span>
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={remove.isPending}
            onClick={() => {
              remove.mutate();
            }}
          >
            Remove
          </Button>
        </div>
      )}

      <form
        className="mt-6 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <div className="space-y-2">
          <Label>Provider</Label>
          <Select
            value={provider}
            onValueChange={(value) => {
              setProvider(value as ProviderId);
              setModel(models.data?.[value as ProviderId][0]?.id ?? "");
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Choose a provider" />
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
          <Label>Model</Label>
          <Select
            value={model}
            // Radix's hidden native select reports "" when the options swap; keep the chosen model.
            onValueChange={(value) => {
              if (value) setModel(value);
            }}
            disabled={!provider}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Choose a model" />
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
          <Label htmlFor="api-key">API key</Label>
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
          {save.isPending ? "Checking the key…" : credential.data ? "Replace key" : "Save key"}
        </Button>
        {save.error && <p className="text-sm text-destructive">{save.error.message}</p>}
      </form>
    </CentredPage>
  );
}
