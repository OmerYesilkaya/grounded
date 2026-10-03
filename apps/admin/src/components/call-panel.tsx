import type { CallDetail, Json } from "@grounded/core/admin";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { Fold, Text } from "@/components/text";
import { Failed, Loading } from "@/components/ui";
import { adminApi } from "@/lib/api";
import { count, duration, learnerName, usd, when } from "@/lib/format";

/**
 * A model call in full (design §4.4, §10.1): the prompt as sent, message by message, what else it
 * asked for, the reply with its reasoning and tool calls, and what the validators decided.
 */
export function CallPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const call = useQuery({ queryKey: ["call", id], queryFn: () => adminApi.call(id) });
  return (
    <div className="rounded-lg border border-border-strong bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Model call</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close the call"
          className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>
      {call.isPending ? (
        <Loading />
      ) : call.isError ? (
        <Failed error={call.error} />
      ) : (
        <Detail c={call.data} />
      )}
    </div>
  );
}

function Detail({ c }: { c: CallDetail }) {
  const verdict = c.content?.verdict;
  const prompt = c.content?.prompt ?? [];
  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Purpose</dt>
        <dd>{c.purpose}</dd>
        <dt className="text-muted-foreground">Model</dt>
        <dd>
          {c.provider} · {c.model}
        </dd>
        <dt className="text-muted-foreground">When</dt>
        <dd>
          {when(c.at)} · {learnerName(c.learner)} · took {duration(c.durationMs)}
        </dd>
        <dt className="text-muted-foreground">Tokens</dt>
        <dd className="tabular-nums">
          {count(c.tokens.input)} in ({count(c.tokens.cachedInput)} cached,{" "}
          {count(c.tokens.cacheWrite)} written to cache) · {count(c.tokens.output)} out ·{" "}
          {usd(c.costUsd)}
        </dd>
        <dt className="text-muted-foreground">Method</dt>
        <dd className="font-mono text-xs">
          {c.methodVersion ?? "not recorded"}
          {c.release ? ` · release ${c.release.slice(0, 7)}` : ""}
        </dd>
        {c.status === "error" && (
          <>
            <dt className="text-destructive">Failed</dt>
            <dd className="text-destructive">{c.errorKind ?? "unknown"}</dd>
          </>
        )}
      </dl>

      {verdict && (
        <div className="rounded-md border border-border p-2 text-sm">
          <p className="font-medium">
            {verdict.rewrite === 0 ? "First writing" : `Rewrite ${String(verdict.rewrite)}`} ·{" "}
            {verdict.issues.length === 0
              ? "passed the validators"
              : `${String(verdict.issues.length)} issue${verdict.issues.length === 1 ? "" : "s"}`}
          </p>
          <ul className="mt-1 space-y-1">
            {verdict.issues.map((issue, i) => (
              <li key={String(i)} className="text-xs">
                <span className="font-mono text-destructive">{issue.code ?? "(no code)"}</span>
                {issue.stepId ? (
                  <span className="text-muted-foreground"> {issue.stepId}</span>
                ) : null}{" "}
                {issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {!c.content ? (
        <p className="text-sm text-muted-foreground">
          This call's content wasn't kept: it was made before every call was stored.
        </p>
      ) : (
        <>
          <section>
            <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              Prompt · {prompt.length} messages
            </h3>
            {prompt.map((message, i) => (
              <PromptMessage key={String(i)} message={message} last={i === prompt.length - 1} />
            ))}
          </section>
          <section>
            <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              Reply
            </h3>
            {c.content.reply ? (
              <>
                {c.content.reply.content.map((part, i) => (
                  <ReplyPart key={String(i)} part={part} />
                ))}
                {c.content.reply.finishReason !== undefined && (
                  <p className="mt-1 text-xs text-subtle-foreground">
                    Finished: {JSON.stringify(c.content.reply.finishReason)}
                  </p>
                )}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">No reply.</p>
            )}
          </section>
          {c.content.error !== null && (
            <Fold title="Error" open>
              <JsonView value={c.content.error} />
            </Fold>
          )}
          {c.content.responseFormat !== null && (
            <Fold title="Response format">
              <JsonView value={c.content.responseFormat} />
            </Fold>
          )}
          {c.content.tools && (
            <Fold title={`Tools offered (${String(c.content.tools.length)})`}>
              <JsonView value={c.content.tools} />
            </Fold>
          )}
          <Fold title="Settings">
            <JsonView value={c.content.settings} />
          </Fold>
          {c.content.reply?.providerMetadata !== undefined && (
            <Fold title="Provider metadata">
              <JsonView value={c.content.reply.providerMetadata} />
            </Fold>
          )}
        </>
      )}
    </div>
  );
}

const isObject = (value: Json): value is Record<string, Json> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A message's text parts as text; anything else (a file, a tool result) as JSON. */
function partsOf(content: Json): { text: string | null; other: Json | null }[] {
  if (typeof content === "string") return [{ text: content, other: null }];
  if (!Array.isArray(content)) return [{ text: null, other: content }];
  return content.map((part) =>
    isObject(part) &&
    (part.type === "text" || part.type === "reasoning") &&
    typeof part.text === "string"
      ? { text: part.text, other: null }
      : { text: null, other: part },
  );
}

function PromptMessage({ message, last }: { message: Json; last: boolean }) {
  const role = isObject(message) && typeof message.role === "string" ? message.role : "message";
  const parts = partsOf(isObject(message) ? (message.content ?? null) : message);
  const size = parts.reduce((n, p) => n + (p.text?.length ?? 0), 0);
  return (
    <Fold title={`${role} · ${count(size)} characters`} open={last}>
      {parts.map((part, i) =>
        part.text !== null ? (
          <Text key={String(i)} mono>
            {part.text}
          </Text>
        ) : (
          <JsonView key={String(i)} value={part.other} />
        ),
      )}
    </Fold>
  );
}

function ReplyPart({ part }: { part: Json }) {
  if (isObject(part) && typeof part.text === "string") {
    if (part.type === "reasoning")
      return (
        <Fold title="Reasoning">
          <Text mono>{part.text}</Text>
        </Fold>
      );
    return (
      <div className="mt-1 rounded-md border border-border p-2">
        <Text mono>{part.text}</Text>
      </div>
    );
  }
  const label =
    isObject(part) && typeof part.type === "string"
      ? `${part.type}${typeof part.toolName === "string" ? ` · ${part.toolName}` : ""}`
      : "part";
  return (
    <Fold title={label}>
      <JsonView value={part} />
    </Fold>
  );
}

function JsonView({ value }: { value: unknown }) {
  return (
    <pre className="max-h-96 overflow-auto rounded-md bg-muted p-2 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}
