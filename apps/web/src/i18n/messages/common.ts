import { defineMessages } from "../define";

/** What many places say alike: generic failures, the snooze and due words, a session's name. */
export const common = defineMessages({
  en: {
    failed: "That didn't go through. Try again.",
    failedMoment: "That didn't go through. Try again in a moment.",
    tryAgain: "Try again",
    cancel: "Cancel",
    save: "Save",
    add: "Add",
    home: "Grounded, home",
    session: (n: number) => `Session ${String(n)}`,
    /** The tag on homework or an exam put off (design §9.2); further off, its date. */
    dueTag: { due: "due", today: "today", tonight: "tonight", tomorrow: "tomorrow" },
    snooze: { tonight: "Tonight", tomorrow: "Tomorrow" },
  },
  tr: {
    failed: "Bu sefer olmadı. Bir daha dene.",
    failedMoment: "Bu sefer olmadı. Birazdan bir daha dene.",
    tryAgain: "Bir daha dene",
    cancel: "Vazgeç",
    save: "Kaydet",
    add: "Ekle",
    home: "Grounded, ana sayfa",
    session: (n: number) => `${String(n)}. oturum`,
    dueTag: { due: "vakti geldi", today: "bugün", tonight: "bu akşam", tomorrow: "yarın" },
    snooze: { tonight: "Bu akşam", tomorrow: "Yarın" },
  },
});
