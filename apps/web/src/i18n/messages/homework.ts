import { defineMessages } from "../define";

/** Homework and arc exams (design §7.4): their page, answer boxes, review, reminders, the editor. */
export const homework = defineMessages({
  en: {
    /** What each kind of task is called. */
    forms: {
      predict: "Predict, then verify",
      derivation: "Derivation",
      build: "Build",
      explain: "Explain it to a friend",
    },
    /** Each answer field's label and what its empty box says. */
    fields: {
      prediction: {
        label: "Your prediction",
        placeholder: "Before you check anything: what will happen, and why?",
      },
      observed: { label: "What actually happened", placeholder: "Now check it. What did you see?" },
      reconcile: {
        label: "Reconcile",
        placeholder: "Where your prediction and what happened differ, and why.",
      },
      work: {
        label: "What you made",
        placeholder: "Your text, code or photos: paste a picture of a page if it's on paper.",
      },
      surprised: {
        label: "What surprised you",
        placeholder: "Anything that didn't go the way you expected.",
      },
      text: {
        label: "Your explanation",
        placeholder: "In your own words, for a smart friend who wasn't there.",
      },
    },
    /** A derivation's steps, each with its "because…". */
    step: (n: number) => `Step ${String(n)}`,
    firstStepPlaceholder: "Start from what you know is true.",
    nextStepPlaceholder: "What follows next.",
    because: "Because…",
    becausePlaceholder: "Why it has to be so.",
    addStep: "Add a step",
    opensOnceLocked: "Opens once your prediction is locked.",
    locked: (when: string) => `Locked ${when}`,
    lockPrediction: "Lock my prediction",
    lockNote: "It can't change once locked. Then check it.",
    predictionNotLocked: "Your prediction wasn't locked.",
    answerNotSaved: "Your answer wasn't saved.",

    /** The page. */
    examEyebrow: (parts: number) => `Arc exam · ${String(parts)} parts`,
    homeworkEyebrow: (form: string) => `Homework · ${form}`,
    setLine: (p: { session: number; track: string; when: string }) =>
      `From session ${String(p.session)} of ${p.track} · set ${p.when}`,
    theExam: "The exam",
    yourAnswer: "Your answer",
    comments: "Comments",
    goodAnswerShows: "A good answer shows",
    saveStatus: { saved: "Saved", saving: "Saving…", failed: "Not saved" },
    oneSitting:
      "Everything here is new ground, built from the whole arc. Take it in one sitting, when you have room for it: your answers are kept as you write, and it is handed in, and reviewed, only once every part is answered. If now isn't the time, put it off with Later.",
    foldedInto: "Folded into a later homework, which covers this one too:",
    handedInAt: (when: string) => `Handed in ${when}.`,
    handIn: "Hand it in",
    notHandedIn: "It wasn't handed in. Try again.",
    laterCloses: "Later closes the session; the homework waits in your track until then.",
    /** When it was put off till, as a sentence's start: "Due tonight:". */
    duePrefix: {
      due: "Due now:",
      today: "Due today:",
      tonight: "Due tonight:",
      tomorrow: "Due tomorrow:",
      later: (date: string) => `Due ${date}:`,
    },
    /** "Due tonight: it waits in your track until you hand it in." */
    waitsInTrack: (due: string | null, exam: boolean) =>
      `${due ?? "Open:"} it waits in your track until you hand it in${exam ? ", every part answered" : ""}.`,
    part: (n: number) => `Part ${String(n)}`,
    partEyebrow: (n: number, form: string) => `Part ${String(n)} · ${form}`,

    /** The self-check. */
    tickNote: "Tick what your answer shows before you hand it in. Only you see the ticks.",

    /** The review. */
    marks: { held: "Held", leaked: "Leaked", missing: "Missing" },
    theReview: "The review",
    reviewing: "Reviewing your answer…",
    commentsWillAppear:
      "Its comments will appear beside your answer, each on the words it is about.",
    whatYourAnswerShows: "What your answer shows",
    seeComment: "See the comment",
    noComments: "No comments: nothing in your answer leaked.",
    allFound: "You found every flaw the comments pointed at.",
    openComments: (n: number) =>
      `${String(n)} ${n === 1 ? "comment asks" : "comments ask"} you to look again at your answer: find the flaw, and reply in the card.`,
    reviewFailed: "The review didn't go through.",
    failed: "That didn't go through.",
    reviewAgain: "Review it again",
    found: "Found · ",
    lookAgain: "Look again",
    replies: (n: number) => (n === 1 ? "1 reply" : `${String(n)} replies`),
    youFoundIt: "You found the flaw.",
    yourReply: "Your reply",
    answering: "Answering…",
    lookAgainThenReply: "Look again, then reply…",
    reply: "Reply",
    aComment: "A comment on your answer",
    openComment: "Open this comment on your answer",

    /** Under the homework's message in the chat. */
    seeReview: "See the review",
    seeIt: "See it",
    openExam: "Open the exam",
    openHomework: "Open the homework",
    handedInReviewing: "Handed in: the review is on its way, beside your answer",
    handedIn: "Handed in",
    foldedCovers: "Folded into a later homework, which covers it too.",
    examSitting: (due: string | null) =>
      `${due ? `${due} take` : "Take"} it in one sitting when you have room; it is handed in whole.`,
    stillOpen: (due: string | null) =>
      `${due ?? "Still open:"} it waits in your track until you hand it in.`,

    /** "Later". */
    later: "Later",
    remindMe: "Remind me",

    /** The reminder once it is due. */
    due: { homework: "Homework due", exam: "Arc exam due" },
    reminderWhere: (track: string, session: number) => `${track} · session ${String(session)}`,
    moreDue: (n: number) => ` · and ${String(n)} more due`,
    notNow: "Not now",
    openIt: "Open it",

    /** The answer editor. */
    addingPicture: "Adding the picture…",
    editorHint: "**bold** · `code` · ``` code block · $x^2$ maths · paste a photo",
    addPicture: "Add a picture",
    pictureNotAdded: "The picture wasn't added.",
  },
  tr: {
    forms: {
      predict: "Tahmin et, sonra doğrula",
      derivation: "Çıkarım",
      build: "Bir şey yap",
      explain: "Bir arkadaşına anlat",
    },
    fields: {
      prediction: {
        label: "Tahminin",
        placeholder: "Hiçbir şeye bakmadan önce: ne olacak, neden?",
      },
      observed: { label: "Gerçekte ne oldu", placeholder: "Şimdi kontrol et. Ne gördün?" },
      reconcile: {
        label: "Karşılaştır",
        placeholder: "Tahminin ile olanın nerede ayrıldığı ve neden.",
      },
      work: {
        label: "Yaptığın",
        placeholder: "Metnin, kodun ya da fotoğrafların: kâğıttaysa sayfanın fotoğrafını yapıştır.",
      },
      surprised: {
        label: "Seni şaşırtan",
        placeholder: "Beklediğin gibi gitmeyen her şey.",
      },
      text: {
        label: "Açıklaman",
        placeholder: "Kendi sözlerinle, orada olmayan zeki bir arkadaşın için.",
      },
    },
    step: (n: number) => `${String(n)}. adım`,
    firstStepPlaceholder: "Doğru olduğunu bildiğin şeyden başla.",
    nextStepPlaceholder: "Ardından ne geliyor.",
    because: "Çünkü…",
    becausePlaceholder: "Neden böyle olmak zorunda.",
    addStep: "Adım ekle",
    opensOnceLocked: "Tahminini kilitleyince açılır.",
    locked: (when: string) => `Kilitlendi: ${when}`,
    lockPrediction: "Tahminimi kilitle",
    lockNote: "Kilitlendikten sonra değişmez. Sonra doğrula.",
    predictionNotLocked: "Tahminin kilitlenmedi.",
    answerNotSaved: "Cevabın kaydedilmedi.",

    examEyebrow: (parts: number) => `Bölüm sınavı · ${String(parts)} kısım`,
    homeworkEyebrow: (form: string) => `Ödev · ${form}`,
    setLine: (p: { session: number; track: string; when: string }) =>
      `${p.track}, ${String(p.session)}. oturum · ${p.when} tarihinde verildi`,
    theExam: "Sınav",
    yourAnswer: "Cevabın",
    comments: "Yorumlar",
    goodAnswerShows: "İyi bir cevap şunları gösterir",
    saveStatus: { saved: "Kaydedildi", saving: "Kaydediliyor…", failed: "Kaydedilmedi" },
    oneSitting:
      "Buradaki her şey yeni: bütün bölümün üzerine kurulu. Vaktin olduğunda tek seferde çöz. Yazdıkça cevapların saklanır; sınav ancak her kısım cevaplandığında teslim edilir ve değerlendirilir. Şimdi uygun değilse Sonra ile ertele.",
    foldedInto: "Bu ödev, onu da kapsayan sonraki bir ödeve katıldı:",
    handedInAt: (when: string) => `${when} tarihinde teslim edildi.`,
    handIn: "Teslim et",
    notHandedIn: "Teslim edilemedi. Bir daha dene.",
    laterCloses: "Sonra dersen oturum kapanır; ödev o zamana kadar konunda bekler.",
    duePrefix: {
      due: "Vakti geldi;",
      today: "Bugün hatırlatılacak;",
      tonight: "Bu akşam hatırlatılacak;",
      tomorrow: "Yarın hatırlatılacak;",
      later: (date: string) => `${date} tarihinde hatırlatılacak;`,
    },
    waitsInTrack: (due: string | null, exam: boolean) =>
      `${due ?? "Açık;"} ${exam ? "her kısmı cevaplayıp " : ""}teslim edene kadar konunda bekliyor.`,
    part: (n: number) => `${String(n)}. kısım`,
    partEyebrow: (n: number, form: string) => `${String(n)}. kısım · ${form}`,

    tickNote:
      "Teslim etmeden önce cevabının gösterdiklerini işaretle. İşaretleri yalnızca sen görürsün.",

    marks: { held: "Sağlam", leaked: "Aksadı", missing: "Eksik" },
    theReview: "Değerlendirme",
    reviewing: "Cevabın değerlendiriliyor…",
    commentsWillAppear:
      "Yorumlar cevabının yanında, her biri ilgili olduğu sözlerin hizasında görünecek.",
    whatYourAnswerShows: "Cevabının gösterdikleri",
    seeComment: "Yoruma bak",
    noComments: "Yorum yok: cevabında aksayan bir şey yok.",
    allFound: "Yorumların gösterdiği her kusuru buldun.",
    openComments: (n: number) =>
      `${String(n)} yorum cevabına bir daha bakmanı istiyor: kusuru bul ve kartta yanıtla.`,
    reviewFailed: "Değerlendirme yapılamadı.",
    failed: "Bu sefer olmadı.",
    reviewAgain: "Yeniden değerlendir",
    found: "Bulundu · ",
    lookAgain: "Bir daha bak",
    replies: (n: number) => `${String(n)} yanıt`,
    youFoundIt: "Kusuru buldun.",
    yourReply: "Yanıtın",
    answering: "Yanıtlanıyor…",
    lookAgainThenReply: "Bir daha bak, sonra yanıtla…",
    reply: "Yanıtla",
    aComment: "Cevabına bir yorum",
    openComment: "Cevabındaki bu yorumu aç",

    seeReview: "Değerlendirmeye bak",
    seeIt: "Ona bak",
    openExam: "Sınavı aç",
    openHomework: "Ödevi aç",
    handedInReviewing: "Teslim edildi: değerlendirme yolda, cevabının yanında görünecek",
    handedIn: "Teslim edildi",
    foldedCovers: "Onu da kapsayan sonraki bir ödeve katıldı.",
    examSitting: (due: string | null) =>
      `${due ? `${due} vaktin` : "Vaktin"} olduğunda tek seferde çöz; bütün hâlinde teslim edilir.`,
    stillOpen: (due: string | null) =>
      `${due ?? "Hâlâ açık;"} teslim edene kadar konunda bekliyor.`,

    later: "Sonra",
    remindMe: "Bana hatırlat",

    due: { homework: "Ödevin vakti geldi", exam: "Bölüm sınavının vakti geldi" },
    reminderWhere: (track: string, session: number) => `${track} · ${String(session)}. oturum`,
    moreDue: (n: number) => ` · vakti gelen ${String(n)} tane daha`,
    notNow: "Şimdi değil",
    openIt: "Aç",

    addingPicture: "Resim ekleniyor…",
    editorHint: "**kalın** · `kod` · ``` kod bloğu · $x^2$ matematik · fotoğraf yapıştır",
    addPicture: "Resim ekle",
    pictureNotAdded: "Resim eklenmedi.",
  },
});
