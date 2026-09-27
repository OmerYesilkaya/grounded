export interface SseEvent {
  id: string;
  event: string;
  data: unknown;
}

/** Reads server-sent events from a streaming response, a few at a time. */
export function readSse(response: Response) {
  const body = response.body;
  if (!body) throw new Error("response has no body");
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  const queue: SseEvent[] = [];

  const parse = () => {
    for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
      const chunk = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const fields = Object.fromEntries(
        chunk
          .split("\n")
          .filter((line) => line && !line.startsWith(":"))
          .map((line) => [
            line.slice(0, line.indexOf(":")),
            line.slice(line.indexOf(":") + 1).trimStart(),
          ]),
      ) as Record<string, string>;
      if (fields.data !== undefined)
        queue.push({
          id: fields.id ?? "",
          event: fields.event ?? "message",
          data: JSON.parse(fields.data) as unknown,
        });
    }
  };

  return {
    async next(count: number, timeoutMs = 5000): Promise<SseEvent[]> {
      const deadline = Date.now() + timeoutMs;
      while (queue.length < count) {
        if (Date.now() > deadline)
          throw new Error(
            `timed out waiting for ${String(count)} events (got ${String(queue.length)})`,
          );
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        parse();
      }
      return queue.splice(0, count);
    },
  };
}
