/** One event of a session's log, as the stream delivers it. */
export interface StreamEvent {
  type: string;
  id: number;
  data: unknown;
}

const RECONNECT_MS = 3000;

/**
 * Follows a session's event log (api: GET /api/sessions/:id/stream) from after event `after`,
 * handing each event of these types to `onEvent`, in order. EventSource reconnects a dropped stream
 * by itself, but gives up for good when a reconnect gets an error response (a 502 while the API
 * restarts); then a new one opens from the last event seen. Returns how to stop following.
 */
export function followSession(
  sessionId: string,
  after: number,
  types: readonly string[],
  onEvent: (event: StreamEvent) => void,
): () => void {
  let lastSeen = after;
  let source: EventSource | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const listener = (e: MessageEvent<string>) => {
    // The browser's own connection errors arrive as "error" events without data; they aren't ours.
    if (typeof e.data !== "string") return;
    const id = Number(e.lastEventId);
    lastSeen = Math.max(lastSeen, id);
    onEvent({ type: e.type, id, data: JSON.parse(e.data) as unknown });
  };
  const open = () => {
    const current = new EventSource(`/api/sessions/${sessionId}/stream?after=${String(lastSeen)}`);
    for (const type of types) current.addEventListener(type, listener);
    current.addEventListener("error", () => {
      if (current.readyState === EventSource.CLOSED) retry = setTimeout(open, RECONNECT_MS);
    });
    source = current;
  };
  open();
  return () => {
    clearTimeout(retry);
    source?.close();
  };
}
