import type {
  Cause,
  FieldRef,
  Notice,
  NoticeCode,
  ProviderFailureKind,
} from "@grounded/core/notices";
import { defineMessages } from "../define";
import { formatsFor } from "../format";

/*
 * What the API tells the learner (design §9.3): each notice it sends, by its code, in words. The
 * codes are `@grounded/core/notices`; one without words here in every language fails typecheck.
 */

type Of<C extends NoticeCode> = Extract<Notice, { code: C }>;
type Words = { [C in NoticeCode]: (notice: Of<C>) => string };

const enNumber = (n: number) => formatsFor("en").number(n);
const trNumber = (n: number) => formatsFor("tr").number(n);

const EN_PROVIDER: Record<ProviderFailureKind, (name: string) => string> = {
  "invalid-key": (n) =>
    `Your ${n} key was rejected. Check it in Settings, or create a new one on ${n}'s site.`,
  "no-credit": (n) =>
    `Your ${n} account is out of credit. Add credit or raise your spending limit on ${n}'s site.`,
  "rate-limited": (n) => `${n} is limiting requests right now. Wait a minute, then try again.`,
  unreachable: (n) => `${n} couldn't be reached. Try again in a moment.`,
  timeout: (n) => `${n} is taking too long. Try again in a moment.`,
  refused: (n) => `${n} declined to answer this request.`,
  unknown: (n) => `Something went wrong talking to ${n}. Try again in a moment.`,
};

const TR_PROVIDER: Record<ProviderFailureKind, (name: string) => string> = {
  "invalid-key": (n) =>
    `${n} anahtarın reddedildi. Ayarlar'dan kontrol et ya da ${n} sitesinde yeni bir anahtar oluştur.`,
  "no-credit": (n) =>
    `${n} hesabında kredi kalmamış. ${n} sitesinde kredi ekle ya da harcama sınırını yükselt.`,
  "rate-limited": (n) =>
    `${n} şu anda istekleri sınırlıyor. Bir dakika bekle, sonra bir daha dene.`,
  unreachable: (n) => `${n} ile bağlantı kurulamadı. Birazdan bir daha dene.`,
  timeout: (n) => `${n} çok uzun sürüyor. Birazdan bir daha dene.`,
  refused: (n) => `${n} bu isteği yanıtlamadı.`,
  unknown: (n) => `${n} ile konuşurken bir şeyler ters gitti. Birazdan bir daha dene.`,
};

const EN_FIELD = {
  prediction: "Your prediction",
  observed: "What actually happened",
  reconcile: "Reconcile",
  work: "What you made",
  surprised: "What surprised you",
  text: "Your explanation",
};
const TR_FIELD: typeof EN_FIELD = {
  prediction: "Tahminin",
  observed: "Gerçekte ne oldu",
  reconcile: "Karşılaştır",
  work: "Yaptığın",
  surprised: "Seni şaşırtan",
  text: "Açıklaman",
};

const enField = (ref: FieldRef) =>
  ref.field === "step"
    ? `Step ${String(ref.step)}`
    : ref.field === "because"
      ? `Step ${String(ref.step)}, because…`
      : EN_FIELD[ref.field];
const trField = (ref: FieldRef) =>
  ref.field === "step"
    ? `${String(ref.step)}. adım`
    : ref.field === "because"
      ? `${String(ref.step)}. adım, çünkü…`
      : TR_FIELD[ref.field];

const enCause = (cause: Cause): string => {
  switch (cause.code) {
    case "provider-failed":
      return EN_PROVIDER[cause.kind](cause.provider);
    case "no-credential":
      return "Add your AI key in Settings first.";
    case "empty-reply":
      return "The tutor's reply came back empty. Try again.";
    case "our-side":
      return "Something went wrong on our side. Try again in a moment.";
    case "interrupted":
      return "The tutor was interrupted by a problem on our side. Try again.";
  }
};
const trCause = (cause: Cause): string => {
  switch (cause.code) {
    case "provider-failed":
      return TR_PROVIDER[cause.kind](cause.provider);
    case "no-credential":
      return "Önce Ayarlar'dan yapay zekâ anahtarını ekle.";
    case "empty-reply":
      return "Öğretmenin cevabı boş geldi. Bir daha dene.";
    case "our-side":
      return "Bizim tarafımızda bir şeyler ters gitti. Birazdan bir daha dene.";
    case "interrupted":
      return "Öğretmen, bizim tarafımızdaki bir sorun yüzünden yarıda kaldı. Bir daha dene.";
  }
};

const en: Words = {
  "not-found": () => "Not found.",
  "server-error": () => "Something went wrong on our side. Try again in a moment.",
  "sign-in-first": () => "Sign in first.",
  "enter-email-and-password": () => "Enter your email and your password, or your invite code.",
  "email-or-password-wrong": () =>
    "That email and password don't match. The first time, the password is your invite code.",
  "too-many-attempts": () => "Too many wrong tries. Wait a quarter of an hour and try again.",
  "password-length": (n) =>
    `Choose a password of ${enNumber(n.min)} to ${enNumber(n.max)} characters.`,
  "current-password-wrong": () => "That isn't your current password.",
  "credential-incomplete": () => "Choose a provider and a model, and paste your API key.",
  "model-unavailable": () => "That model isn't available for this provider.",
  "goal-required": (n) => `Say what you want to learn, in at most ${enNumber(n.max)} characters.`,
  "files-too-large": () => "The files are too large together.",
  "attachment-kind": (n) =>
    `${n.name}: only images, PDFs, Word documents and text files can be attached.`,
  "attachment-empty": (n) => `${n.name} is empty.`,
  "attachment-too-large": (n) => `${n.name} is larger than ${enNumber(n.megabytes)} MB.`,
  "attachments-too-many": (n) => `Attach at most ${enNumber(n.max)} files.`,
  "attachments-too-large": (n) =>
    `The files come to more than ${enNumber(n.megabytes)} MB together.`,
  "attachment-not-what-it-says": (n) => `${n.name} doesn't look like the file its name says it is.`,
  "attachment-password": (n) =>
    `${n.name} is protected with a password; attach a copy without one.`,
  "attachment-unreadable": (n) =>
    `${n.name} couldn't be read as ${n.as === "pdf" ? "a PDF" : "a Word document"}.`,
  "attachment-not-utf8": (n) => `${n.name} isn't plain text (UTF-8).`,
  "attachment-no-text": (n) => `${n.name} has no text in it.`,
  "attachment-too-long": (n) =>
    `${n.name} has ${enNumber(n.characters)} characters of text; at most ${enNumber(n.max)} can be attached.`,
  "attachments-pdf-pages": (n) =>
    `The PDFs come to ${enNumber(n.pages)} pages; at most ${enNumber(n.max)} can be attached.`,
  "session-open": () => "This track already has an open session.",
  "not-a-session-kind": () => "Not a kind of session.",
  "final-after-exam": () => "The final comes once your arc exam is handed in.",
  "final-done": () => "This track's final is done.",
  "final-after-plan": () => "The final comes once the plan is taught through.",
  "exam-open": (n) => `Your arc exam “${n.title}” is still open.`,
  "write-message": () => "Write a message first.",
  "nothing-to-retry": () => "There is nothing to try again.",
  "tutor-on-it": () => "The tutor is already on it.",
  "tutor-busy": () => "The tutor is still at work here. Try again in a moment.",
  "nothing-to-show": () => "There is nothing to show yet.",
  "no-outline": () => "The lesson has no outline yet: start it over instead.",
  "session-closed": () => "This session is closed.",
  "questions-in-margin": () => "Questions during the lesson go in the margin.",
  "not-taking-messages": () => "The session isn't taking messages now.",
  "no-review": () => "No review is under way.",
  "no-audit": () => "No audit is under way.",
  "no-teach-back": () => "No teach-back is under way.",
  "final-has-no-plan": () => "The final has no plan.",
  "review-before-probe": () => "The review comes before the probe.",
  "probe-over": () => "The probe is already over.",
  "not-planning": () => "Plans are proposed during planning.",
  "no-plan-to-approve": () => "There is no plan to approve yet.",
  "plan-not-approved": () => "The plan hasn't been approved.",
  "no-lesson-being-written": () => "No lesson is being written.",
  "only-failed-lesson": () => "Only a lesson that failed can be written again.",
  "step-not-in-lesson": () => "That step isn't in this lesson.",
  "step-paused": () => "This step is paused; resume it first.",
  "step-not-checked": () => "That step isn't the one being checked.",
  "pause-or-continue-first": () => "Choose to pause or continue first.",
  "pause-not-offered": () => "Pausing wasn't offered for this step.",
  "continue-not-offered": () => "Continuing wasn't offered for this step.",
  "nothing-paused": () => "Nothing is paused.",
  "no-lesson-to-finish": () => "There is no lesson to finish.",
  "checks-open": () => "Some checks are still open.",
  "homework-after-checks": () => "Homework comes after the checks.",
  "no-homework-yet": () => "There is no homework to hand in yet.",
  "no-homework-in-review": () => "There is no homework being reviewed.",
  "recap-after-teach-back": () => "The recap comes after the teach-back.",
  "recap-after-homework": () => "The recap comes after the homework.",
  "write-answer-or-dont-know": () => "Write an answer, or say you don't know.",
  "step-being-written": () => "This step is still being written.",
  "answer-being-checked": () => "Your answer is being checked.",
  "write-question": () => "Write your question first.",
  "passage-not-readable": () => "That passage isn't in the lesson you can read.",
  "question-being-answered": () => "Your last question is being answered.",
  "nothing-to-save": () => "There is nothing to save here.",
  "write-answer": () => "Write an answer first.",
  "task-not-in-assignment": () => "That task isn't in this assignment.",
  "no-prediction-to-lock": () => "There is no prediction to lock.",
  "write-prediction-first": () => "Write your prediction first.",
  "prediction-locked": () => "Your prediction is locked.",
  "lock-prediction-first": (n) =>
    n.part === null
      ? "Lock your prediction before you check it."
      : `Lock your prediction in “${n.part}” before you check it.`,
  "answer-missing": (n) =>
    `Write “${enField(n)}”${n.part === null ? "" : ` in “${n.part}”`} before you hand it in.`,
  "no-such-field": (n) => `This task has no “${n.key}” to write.`,
  "answer-too-long": (n) => `An answer can be at most ${enNumber(n.max)} characters long.`,
  "picture-too-large": (n) => `A picture can be at most ${enNumber(n.megabytes)} MB.`,
  "choose-picture": () => "Choose a picture.",
  "pictures-only": () => "Only pictures (PNG, JPEG, WebP or GIF) can go in an answer.",
  "pictures-too-many": (n) => `At most ${enNumber(n.max)} pictures can go in one assignment.`,
  "choose-when": () => "Choose when: tonight or tomorrow.",
  "tonight-over": () => "Tonight is over; choose tomorrow.",
  "hand-in-first": () => "Hand it in first.",
  "being-reviewed": () => "It is being reviewed already.",
  "write-reply": () => "Write your reply first.",
  "found-already": () => "You've found this one already.",
  "reply-being-answered": () => "Your last reply is being answered.",
  "handed-in": () => "This has been handed in.",
  "folded-into-later": () => "This homework was folded into a later one; do that one instead.",
  "homework-closed": () => "This homework is closed.",
  "write-note": () => "Write the note first.",
  "notes-limit": (n) => `Keep it to ${enNumber(n.max)} notes.`,
  // Why a job failed
  "provider-failed": enCause,
  "no-credential": enCause,
  "empty-reply": enCause,
  "our-side": enCause,
  interrupted: enCause,
  "outline-failed": () =>
    "The lesson's outline didn't fit your term list after three tries: it named terms the list doesn't have, or used them before teaching them.",
  "plan-failed": () => "The plan couldn't be put together. Try asking for it again.",
  "lesson-interrupted": () => "Writing the lesson was interrupted by a problem on our side.",
  "thread-failed": (n) => {
    const why =
      n.cause === null
        ? ""
        : n.cause.code === "interrupted"
          ? " The tutor was interrupted by a problem on our side."
          : ` ${enCause(n.cause)}`;
    const again = { check: "Answer", aside: "Ask", reply: "Reply" }[n.thread];
    return `That didn't go through.${why} ${again} again when you're ready.`;
  },
  // What a job is doing
  thinking: (n) => (n.again ? "Thinking again (the reply came back empty)" : "Thinking…"),
  "rewriting-message": () => "Rewriting the message (it broke a chat rule)",
  "reading-left-off": () => "Reading where you left off",
  "reading-brought": () => "Reading what you brought",
  "noting-answers": () => "Noting what your answers showed",
  "taking-stock": () => "Taking stock of what held",
  researching: () => "Researching the subject",
  "searching-web": (n) =>
    n.query === null ? "Searching the web" : `Searching the web for “${n.query}”`,
  "checking-facts": () => "Checking the facts the lesson needs",
  outlining: () => "Outlining the lesson",
  "writing-step": (n) =>
    n.again
      ? `Rewriting step ${String(n.step)} of ${String(n.of)} (the draft broke a rule)`
      : `Writing step ${String(n.step)} of ${String(n.of)}`,
  "checking-answer": () => "Checking your answer",
  "writing-fresh-question": () => "Writing a fresh question",
  "noting-good-answer": () => "Noting what a good answer shows",
  "updating-terms": () => "Updating your term list",
  "noting-left-off": () => "Noting where you left off",
  "recording-plan": () => "Recording the plan's terms",
  "revising-plan": () => "Revising the plan (the first draft didn't fit)",
  condensing: () => "Condensing our conversation so far",
  reviewing: (n) => (n.exam ? "Reviewing your arc exam" : "Reviewing your homework"),
  "finding-where-knowledge-ends": () => "Working out where your knowledge ends",
  "finding-media": (n) =>
    n.kind === "image"
      ? `Looking for an image of “${n.query}”`
      : `Looking for a recording of “${n.query}”`,
};

export const notices = defineMessages({
  en,
  tr: {
    "not-found": () => "Bulunamadı.",
    "server-error": () => "Bizim tarafımızda bir şeyler ters gitti. Birazdan bir daha dene.",
    "sign-in-first": () => "Önce giriş yap.",
    "enter-email-and-password": () => "E-postanı ve şifreni ya da davet kodunu yaz.",
    "email-or-password-wrong": () =>
      "Bu e-posta ve şifre eşleşmiyor. İlk girişte şifre, sana verilen davet kodudur.",
    "too-many-attempts": () => "Çok fazla yanlış deneme oldu. Çeyrek saat bekleyip bir daha dene.",
    "password-length": (n) =>
      `${trNumber(n.min)} ile ${trNumber(n.max)} karakter arasında bir şifre seç.`,
    "current-password-wrong": () => "Bu, şu anki şifren değil.",
    "credential-incomplete": () => "Bir sağlayıcı ve bir model seç, sonra API anahtarını yapıştır.",
    "model-unavailable": () => "Bu model bu sağlayıcıda yok.",
    "goal-required": (n) => `Ne öğrenmek istediğini en fazla ${trNumber(n.max)} karakterle yaz.`,
    "files-too-large": () => "Dosyalar birlikte çok büyük.",
    "attachment-kind": (n) =>
      `${n.name}: yalnızca resim, PDF, Word belgesi ve metin dosyası eklenebilir.`,
    "attachment-empty": (n) => `${n.name} boş.`,
    "attachment-too-large": (n) => `${n.name}, ${trNumber(n.megabytes)} MB'tan büyük.`,
    "attachments-too-many": (n) => `En fazla ${trNumber(n.max)} dosya ekleyebilirsin.`,
    "attachments-too-large": (n) => `Dosyalar birlikte ${trNumber(n.megabytes)} MB'ı geçiyor.`,
    "attachment-not-what-it-says": (n) =>
      `${n.name}, adının söylediği türde bir dosyaya benzemiyor.`,
    "attachment-password": (n) => `${n.name} şifreyle korunuyor; şifresiz bir kopyasını ekle.`,
    "attachment-unreadable": (n) =>
      `${n.name} ${n.as === "pdf" ? "PDF" : "Word belgesi"} olarak okunamadı.`,
    "attachment-not-utf8": (n) => `${n.name} düz metin (UTF-8) değil.`,
    "attachment-no-text": (n) => `${n.name} içinde hiç metin yok.`,
    "attachment-too-long": (n) =>
      `${n.name} içinde ${trNumber(n.characters)} karakter metin var; en fazla ${trNumber(n.max)} karakter eklenebilir.`,
    "attachments-pdf-pages": (n) =>
      `PDF'ler toplam ${trNumber(n.pages)} sayfa; en fazla ${trNumber(n.max)} sayfa eklenebilir.`,
    "session-open": () => "Bu konunun zaten açık bir oturumu var.",
    "not-a-session-kind": () => "Böyle bir oturum türü yok.",
    "final-after-exam": () => "Final, bölüm sınavını teslim ettiğinde gelir.",
    "final-done": () => "Bu konunun finali bitti.",
    "final-after-plan": () => "Final, plan baştan sona öğretildiğinde gelir.",
    "exam-open": (n) => `“${n.title}” bölüm sınavın hâlâ açık.`,
    "write-message": () => "Önce bir mesaj yaz.",
    "nothing-to-retry": () => "Yeniden denenecek bir şey yok.",
    "tutor-on-it": () => "Öğretmen zaten bunun üzerinde.",
    "tutor-busy": () => "Öğretmen burada hâlâ çalışıyor. Birazdan bir daha dene.",
    "nothing-to-show": () => "Henüz gösterilecek bir şey yok.",
    "no-outline": () => "Dersin henüz bir taslağı yok: bunun yerine baştan başlat.",
    "session-closed": () => "Bu oturum kapandı.",
    "questions-in-margin": () => "Ders sırasındaki sorular kenar boşluğuna yazılır.",
    "not-taking-messages": () => "Oturum şu anda mesaj almıyor.",
    "no-review": () => "Şu anda bir gözden geçirme yok.",
    "no-audit": () => "Şu anda bir yoklama yok.",
    "no-teach-back": () => "Şu anda bir geri anlatma yok.",
    "final-has-no-plan": () => "Finalin bir planı yok.",
    "review-before-probe": () => "Gözden geçirme, nereden başladığını bulmadan önce gelir.",
    "probe-over": () => "Nereden başladığını bulma kısmı zaten bitti.",
    "not-planning": () => "Planlar planlama sırasında önerilir.",
    "no-plan-to-approve": () => "Henüz onaylanacak bir plan yok.",
    "plan-not-approved": () => "Plan henüz onaylanmadı.",
    "no-lesson-being-written": () => "Şu anda yazılan bir ders yok.",
    "only-failed-lesson": () => "Yalnızca yazılamamış bir ders yeniden yazılabilir.",
    "step-not-in-lesson": () => "Bu adım bu derste yok.",
    "step-paused": () => "Bu adıma ara verildi; önce devam ettir.",
    "step-not-checked": () => "Şu an kontrol edilen adım bu değil.",
    "pause-or-continue-first": () => "Önce ara vermeyi ya da devam etmeyi seç.",
    "pause-not-offered": () => "Bu adımda ara verme önerilmedi.",
    "continue-not-offered": () => "Bu adımda devam etme önerilmedi.",
    "nothing-paused": () => "Ara verilmiş bir şey yok.",
    "no-lesson-to-finish": () => "Bitirilecek bir ders yok.",
    "checks-open": () => "Bazı kontrol soruları hâlâ açık.",
    "homework-after-checks": () => "Ödev, kontrol sorularından sonra gelir.",
    "no-homework-yet": () => "Henüz teslim edilecek bir ödev yok.",
    "no-homework-in-review": () => "Değerlendirilen bir ödev yok.",
    "recap-after-teach-back": () => "Özet, geri anlatmadan sonra gelir.",
    "recap-after-homework": () => "Özet, ödevden sonra gelir.",
    "write-answer-or-dont-know": () => "Bir cevap yaz ya da bilmediğini söyle.",
    "step-being-written": () => "Bu adım hâlâ yazılıyor.",
    "answer-being-checked": () => "Cevabın kontrol ediliyor.",
    "write-question": () => "Önce sorunu yaz.",
    "passage-not-readable": () => "Bu bölüm, okuyabildiğin derste yok.",
    "question-being-answered": () => "Son sorun cevaplanıyor.",
    "nothing-to-save": () => "Burada kaydedilecek bir şey yok.",
    "write-answer": () => "Önce bir cevap yaz.",
    "task-not-in-assignment": () => "Bu görev bu ödevde yok.",
    "no-prediction-to-lock": () => "Kilitlenecek bir tahmin yok.",
    "write-prediction-first": () => "Önce tahminini yaz.",
    "prediction-locked": () => "Tahminin kilitli.",
    "lock-prediction-first": (n) =>
      n.part === null
        ? "Kontrol etmeden önce tahminini kilitle."
        : `Kontrol etmeden önce “${n.part}” kısmındaki tahminini kilitle.`,
    "answer-missing": (n) =>
      `Teslim etmeden önce ${n.part === null ? "" : `“${n.part}” kısmındaki `}“${trField(n)}” alanını yaz.`,
    "no-such-field": (n) => `Bu görevde yazılacak bir “${n.key}” yok.`,
    "answer-too-long": (n) => `Bir cevap en fazla ${trNumber(n.max)} karakter olabilir.`,
    "picture-too-large": (n) => `Bir resim en fazla ${trNumber(n.megabytes)} MB olabilir.`,
    "choose-picture": () => "Bir resim seç.",
    "pictures-only": () => "Cevaba yalnızca resim (PNG, JPEG, WebP ya da GIF) eklenebilir.",
    "pictures-too-many": (n) => `Bir ödeve en fazla ${trNumber(n.max)} resim eklenebilir.`,
    "choose-when": () => "Ne zaman olacağını seç: bu akşam ya da yarın.",
    "tonight-over": () => "Bu akşam geçti; yarını seç.",
    "hand-in-first": () => "Önce teslim et.",
    "being-reviewed": () => "Zaten değerlendiriliyor.",
    "write-reply": () => "Önce yanıtını yaz.",
    "found-already": () => "Bunu zaten buldun.",
    "reply-being-answered": () => "Son yanıtın cevaplanıyor.",
    "handed-in": () => "Bu teslim edildi.",
    "folded-into-later": () => "Bu ödev sonraki bir ödevin içine katıldı; onun yerine onu yap.",
    "homework-closed": () => "Bu ödev kapandı.",
    "write-note": () => "Önce notu yaz.",
    "notes-limit": (n) => `En fazla ${trNumber(n.max)} not olabilir.`,
    "provider-failed": trCause,
    "no-credential": trCause,
    "empty-reply": trCause,
    "our-side": trCause,
    interrupted: trCause,
    "outline-failed": () =>
      "Dersin taslağı üç denemede de kavram listene uymadı: listede olmayan kavramlar kullandı ya da kavramları öğretmeden önce kullandı.",
    "plan-failed": () => "Plan bir araya getirilemedi. Bir daha istemeyi dene.",
    "lesson-interrupted": () =>
      "Dersin yazılması, bizim tarafımızdaki bir sorun yüzünden yarıda kaldı.",
    "thread-failed": (n) => {
      const why =
        n.cause === null
          ? ""
          : n.cause.code === "interrupted"
            ? " Öğretmen, bizim tarafımızdaki bir sorun yüzünden yarıda kaldı."
            : ` ${trCause(n.cause)}`;
      const again = {
        check: "Hazır olduğunda bir daha cevapla.",
        aside: "Hazır olduğunda bir daha sor.",
        reply: "Hazır olduğunda bir daha yanıtla.",
      }[n.thread];
      return `Bu sefer olmadı.${why} ${again}`;
    },
    thinking: (n) => (n.again ? "Yeniden düşünüyor (cevap boş geldi)" : "Düşünüyor…"),
    "rewriting-message": () => "Mesaj yeniden yazılıyor (bir sohbet kuralını çiğnedi)",
    "reading-left-off": () => "Kaldığın yer okunuyor",
    "reading-brought": () => "Getirdiklerin okunuyor",
    "noting-answers": () => "Cevaplarının gösterdikleri not ediliyor",
    "taking-stock": () => "Neyin oturduğuna bakılıyor",
    researching: () => "Konu araştırılıyor",
    "searching-web": (n) =>
      n.query === null ? "Web'de aranıyor" : `Web'de aranıyor: “${n.query}”`,
    "checking-facts": () => "Dersin gerektirdiği bilgiler doğrulanıyor",
    outlining: () => "Dersin taslağı çıkarılıyor",
    "writing-step": (n) =>
      n.again
        ? `Adım ${String(n.step)}/${String(n.of)} yeniden yazılıyor (taslak bir kuralı çiğnedi)`
        : `Adım ${String(n.step)}/${String(n.of)} yazılıyor`,
    "checking-answer": () => "Cevabın kontrol ediliyor",
    "writing-fresh-question": () => "Yeni bir soru yazılıyor",
    "noting-good-answer": () => "İyi bir cevabın neyi gösterdiği not ediliyor",
    "updating-terms": () => "Kavram listen güncelleniyor",
    "noting-left-off": () => "Kaldığın yer not ediliyor",
    "recording-plan": () => "Planın kavramları kaydediliyor",
    "revising-plan": () => "Plan gözden geçiriliyor (ilk taslak uymadı)",
    condensing: () => "Şimdiye kadarki sohbetimiz özetleniyor",
    reviewing: (n) => (n.exam ? "Bölüm sınavın değerlendiriliyor" : "Ödevin değerlendiriliyor"),
    "finding-where-knowledge-ends": () => "Bilgilerinin nerede bittiği bulunuyor",
    "finding-media": (n) =>
      n.kind === "image"
        ? `Bir resim aranıyor: “${n.query}”`
        : `Bir ses kaydı aranıyor: “${n.query}”`,
  },
});
