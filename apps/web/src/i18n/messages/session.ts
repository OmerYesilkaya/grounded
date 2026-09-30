import { defineMessages } from "../define";

/** The session page: its chat and composer, what the tutor is doing, a new track. */
export const session = defineMessages({
  en: {
    tabs: { chat: "Chat", lesson: "Lesson" },
    writingLesson: "Writing your lesson",
    stepsPlanned: (n: number) =>
      n === 1
        ? "1 step is planned. It opens as soon as it's written."
        : `${String(n)} steps are planned. The first one opens as soon as it's written.`,
    firstStepOpens: "The first step opens as soon as it's written.",
    gettingStarted: "Getting started…",
    pausedHere: "Paused here.",
    pickUp: "Pick it up again",
    kind: { plan: "The plan", homework: "Homework", exam: "Arc exam", recap: "Recap" },
    part: { audit: "The fresh audit", "teach-back": "The teach-back" },
    placeholder: {
      answer: "Answer in your own words; “I don't know” is fine.",
      teachBack: "In your own words; “I don't know why” is fine too.",
      plan: "Reply to change the plan…",
    },
    lookingOver: "Looking over what came up since last time…",
    thinking: "Thinking…",
    lessonOn: "The lesson is on.",
    openLesson: "Open the lesson",
    finalFoundNext: "A next session takes up what the final found.",
    sessionDone: "This session is done.",
    startNext: "Start the next session",
    stopped: "The tutor stopped before finishing.",
    approvePlan: "Approve the plan",
    orReply: "or reply below to change it",
    jumpToLatest: "Jump to latest",
    message: "Message",
    send: "Send",
    attachFiles: "Attach files",
    showThinking: "Show thinking",
    hideThinking: "Hide thinking",
    review: {
      sinceLastTime: "Since last time",
      exam: "Arc exam",
      homework: "Homework",
      thisSession: "This session",
    },
    final: {
      title: "The final",
      parts: "Its parts",
      partNames: { audit: "Fresh audit", teachBack: "Teach-back", found: "What it found" },
      intro:
        "Two parts and no homework. A fresh audit of where you stand across the whole subject, then a teach-back: you rebuild it from its foundations, and the tutor keeps asking why and what if. Answer in your own words; there is nothing to look up.",
    },
    attachment: {
      remove: (name: string) => `Remove ${name}`,
      /** Why a file can't be attached, under its name on the chip. */
      kind: "Only images, PDFs, Word documents and text files.",
      empty: "Empty.",
      tooLarge: (megabytes: string) => `Larger than ${megabytes} MB.`,
      bytes: (n: string) => `${n} B`,
      kilobytes: (n: string) => `${n} KB`,
      megabytes: (n: string) => `${n} MB`,
    },
    newTrack: {
      title: "A new subject",
      intro:
        "Each subject is its own track, with its own words and its own plan. Write in whichever language you want to learn in.",
      question: "What do you want to learn?",
      placeholder:
        "Say where you want to get to, and where you're starting from: what you already know, what it's for, anything that makes it yours.",
      creating: "Creating…",
      create: "Create track",
      attached: "Attached files",
      attachHint:
        "Attach anything that shows where you start or where you’re heading: a CV, a syllabus, notes, a photo of a page (images, PDFs, Word documents and text files).",
      shortcut: (key: string) => `${key} Enter to create.`,
    },
  },
  tr: {
    tabs: { chat: "Sohbet", lesson: "Ders" },
    writingLesson: "Dersin yazılıyor",
    stepsPlanned: (n: number) => `${String(n)} adım planlandı. İlki yazılır yazılmaz açılır.`,
    firstStepOpens: "İlk adım yazılır yazılmaz açılır.",
    gettingStarted: "Başlanıyor…",
    pausedHere: "Burada ara verdin.",
    pickUp: "Kaldığın yerden devam et",
    kind: { plan: "Plan", homework: "Ödev", exam: "Bölüm sınavı", recap: "Özet" },
    part: { audit: "Taze yoklama", "teach-back": "Geri anlatma" },
    placeholder: {
      answer: "Kendi sözlerinle cevap ver; “bilmiyorum” demek de olur.",
      teachBack: "Kendi sözlerinle; “nedenini bilmiyorum” demek de olur.",
      plan: "Planı değiştirmek için yaz…",
    },
    lookingOver: "Geçen seferden beri olanlara bakılıyor…",
    thinking: "Düşünüyor…",
    lessonOn: "Ders başladı.",
    openLesson: "Dersi aç",
    finalFoundNext: "Sonraki oturum, finalin bulduklarından devam eder.",
    sessionDone: "Bu oturum bitti.",
    startNext: "Sonraki oturumu başlat",
    stopped: "Öğretmen bitirmeden durdu.",
    approvePlan: "Planı onayla",
    orReply: "ya da değiştirmek için aşağıya yaz",
    jumpToLatest: "En sona git",
    message: "Mesaj",
    send: "Gönder",
    attachFiles: "Dosya ekle",
    showThinking: "Düşüncesini göster",
    hideThinking: "Düşüncesini gizle",
    review: {
      sinceLastTime: "Geçen seferden beri",
      exam: "Bölüm sınavı",
      homework: "Ödev",
      thisSession: "Bu oturum",
    },
    final: {
      title: "Final",
      parts: "Bölümleri",
      partNames: { audit: "Taze yoklama", teachBack: "Geri anlatma", found: "Bulunanlar" },
      intro:
        "İki bölüm var, ödev yok. Önce bütün konuda nerede durduğuna taze bir yoklama, sonra geri anlatma: konuyu temellerinden yeniden kurarsın, öğretmen de durmadan neden ve ya şöyle olsaydı diye sorar. Kendi sözlerinle cevap ver; bakman gereken bir şey yok.",
    },
    attachment: {
      remove: (name: string) => `${name} dosyasını kaldır`,
      kind: "Yalnızca resim, PDF, Word belgesi ve metin dosyası.",
      empty: "Boş.",
      tooLarge: (megabytes: string) => `${megabytes} MB'tan büyük.`,
      bytes: (n: string) => `${n} B`,
      kilobytes: (n: string) => `${n} KB`,
      megabytes: (n: string) => `${n} MB`,
    },
    newTrack: {
      title: "Yeni bir konu",
      intro:
        "Her konunun kendi sözcükleri ve kendi planı var. Hangi dilde öğrenmek istiyorsan o dilde yaz.",
      question: "Ne öğrenmek istiyorsun?",
      placeholder:
        "Nereye varmak istediğini ve nereden başladığını anlat: ne bildiğini, ne için istediğini, onu sana özgü kılan her şeyi.",
      creating: "Oluşturuluyor…",
      create: "Konuyu oluştur",
      attached: "Eklenen dosyalar",
      attachHint:
        "Nereden başladığını ya da nereye gittiğini gösteren her şeyi ekleyebilirsin: bir özgeçmiş, bir müfredat, notlar, bir sayfanın fotoğrafı (resimler, PDF'ler, Word belgeleri ve metin dosyaları).",
      shortcut: (key: string) => `Oluşturmak için ${key} Enter.`,
    },
  },
});
