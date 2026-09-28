import type { Aside, AsideAnchor, AsideMessage, LessonAsides } from "@/lesson/types";
import { api } from "./api";

/** The session's stream events about asides (api: engine/asides.ts). */
export const ASIDE_EVENT_TYPES = [
  "aside",
  "aside-message",
  "aside-delta",
  "aside-tangent",
  "aside-saved",
] as const;

const isAsideEvent = (type: string): type is (typeof ASIDE_EVENT_TYPES)[number] =>
  (ASIDE_EVENT_TYPES as readonly string[]).includes(type);

/** The question an aside's answer is on its way for: its thread ends with the learner. */
const waitingOn = (aside: Aside) => {
  const last = aside.messages.at(-1);
  return last?.role === "learner" ? last : null;
};

/**
 * Folds an aside event into the session's asides; null when the event isn't about asides. Replays
 * may repeat events: everything is keyed by id.
 */
export function reduceAsides(asides: Aside[], type: string, data: unknown): Aside[] | null {
  if (!isAsideEvent(type)) return null;
  const event = data as Record<string, unknown>;
  const update = (id: unknown, change: (aside: Aside) => Aside) =>
    asides.map((aside) => (aside.id === id ? change(aside) : aside));
  switch (type) {
    case "aside": {
      if (asides.some((a) => a.id === event.id)) return asides;
      const aside: Aside = {
        id: event.id as string,
        stepId: event.stepId as string,
        anchor: event.anchor as AsideAnchor,
        messages: [],
        draft: null,
        tangent: null,
        saved: false,
      };
      return [...asides, aside];
    }
    case "aside-message": {
      const message = event as unknown as AsideMessage & { asideId: string };
      return update(message.asideId, (aside) => {
        if (aside.messages.some((m) => m.id === message.id)) return aside;
        // The answer keeps the text it streamed as, so the card finishes revealing it before it
        // turns into its blocks.
        const text = message.role === "tutor" ? aside.draft : message.text;
        return {
          ...aside,
          messages: [
            ...aside.messages,
            {
              id: message.id,
              role: message.role,
              text,
              blocks: message.blocks,
            },
          ],
          draft: null,
        };
      });
    }
    case "aside-delta":
      return update(event.asideId, (aside) =>
        waitingOn(aside)?.id === event.replyTo
          ? { ...aside, draft: (aside.draft ?? "") + (event.text as string) }
          : aside,
      );
    case "aside-tangent":
      return update(event.asideId, (aside) => ({ ...aside, tangent: event.tangent as string }));
    case "aside-saved":
      return update(event.asideId, (aside) => ({ ...aside, saved: true }));
  }
}

/** Asking, following up and saving, for the lesson view (routes/asides.ts). */
export function asideActions(
  sessionId: string,
): Pick<LessonAsides, "onAsk" | "onFollowUp" | "onSave"> {
  const base = `/api/sessions/${sessionId}/asides`;
  return {
    onAsk: async (anchor, text) =>
      (
        await api<{ id: string }>(base, {
          method: "POST",
          body: JSON.stringify({ anchor, text }),
        })
      ).id,
    onFollowUp: async (asideId, text) => {
      await api(`${base}/${asideId}/messages`, { method: "POST", body: JSON.stringify({ text }) });
    },
    onSave: (asideId) => {
      void api(`${base}/${asideId}/save`, { method: "POST" });
    },
  };
}
