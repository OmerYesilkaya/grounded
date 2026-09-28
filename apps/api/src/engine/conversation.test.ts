import { describe, expect, it } from "vitest";
import {
  CONVERSATION_LIMIT,
  conversationFor,
  dueForSummary,
  KEEP_RECENT,
  type StoredMessage,
} from "./conversation.js";

const turns = (count: number, length: number): StoredMessage[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `m${String(i)}`,
    role: i % 2 === 0 ? "tutor" : "learner",
    text: `${String(i)} `.padEnd(length, "x"),
  }));

describe("a long session's conversation", () => {
  it("is carried in full while it is short enough", () => {
    const history = turns(20, 1000);
    expect(dueForSummary(history, null)).toEqual([]);
    expect(conversationFor(history, null)).toHaveLength(20);
  });

  it("past the limit, folds all but the last messages into the summary", () => {
    const history = turns(60, 1000);
    expect(60 * 1000).toBeGreaterThan(CONVERSATION_LIMIT);
    const due = dueForSummary(history, null);
    expect(due.map((m) => m.id)).toEqual(history.slice(0, -KEEP_RECENT).map((m) => m.id));
  });

  it("carries the summary in place of the turns it covers, then the rest in full", () => {
    const history = turns(60, 1000);
    const messages = conversationFor(history, { text: "What happened.", through: "m49" });
    expect(messages).toHaveLength(1 + KEEP_RECENT);
    expect(messages[0]).toEqual({
      role: "user",
      content:
        "(The app: the start of this session, summarized. The conversation goes on from there.)\n\nWhat happened.",
    });
    expect(messages[1]).toEqual({ role: "assistant", content: history[50]?.text });
  });

  it("rolls forward only once the turns after the summary pass the limit again", () => {
    const history = turns(91, 1000);
    const summary = { text: "What happened.", through: "m49" };
    expect(dueForSummary(history.slice(0, 80), summary)).toEqual([]);
    expect(dueForSummary(history, summary).map((m) => m.id)).toEqual(
      history.slice(50, -KEEP_RECENT).map((m) => m.id),
    );
  });

  it("carries everything in full if the summary's last message is gone", () => {
    const history = turns(12, 10);
    expect(conversationFor(history, { text: "Gone.", through: "missing" })).toHaveLength(12);
  });
});
