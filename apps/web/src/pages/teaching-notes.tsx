import { useQuery } from "@tanstack/react-query";
import { PhoneBar } from "@/components/page-bar";
import { Link } from "@tanstack/react-router";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/i18n";
import { ApiError } from "@/lib/api";
import {
  aboutQuery,
  teachingNotesQuery,
  useAboutChange,
  useNoteChange,
  type TeachingNote,
} from "@/lib/teaching-notes";

/** What the learner may write about themselves, in characters (api: ABOUT_MAX). */
const ABOUT_MAX = 2000;

/**
 * The learner's profile (design §8): what they wrote about themselves, theirs alone, and their
 * teaching notes, what the tutor has noticed about how they learn. Every call reads both. The
 * learner can change or remove any note, and add their own.
 */
export function TeachingNotesPage() {
  const notes = useQuery(teachingNotesQuery);
  const [adding, setAdding] = useState(false);
  const t = useT().account.notes;
  return (
    <>
      <PhoneBar />
      <main className="mx-auto w-full max-w-2xl px-6 pt-24 pb-24 max-md:pt-10">
        <p className="text-xs tracking-widest text-subtle-foreground uppercase">{t.eyebrow}</p>
        <h1 className="mt-1 font-serif text-3xl font-semibold tracking-tight">{t.title}</h1>
        <p className="mt-2 max-w-prose text-sm text-muted-foreground">{t.intro}</p>
        <AboutYou />
        <h2 className="mt-12 font-serif text-xl font-semibold tracking-tight">{t.notesTitle}</h2>
        <p className="mt-1 max-w-prose text-sm text-muted-foreground">{t.notesIntro}</p>
        {notes.data && (
          <>
            {notes.data.length === 0 && !adding && (
              <p className="mt-6 rounded-lg border border-dashed px-5 py-4 text-sm text-muted-foreground">
                {t.none}
              </p>
            )}
            {notes.data.length > 0 && (
              <ul className="mt-6 divide-y border-y">
                {notes.data.map((note) => (
                  <Note key={note.id} note={note} />
                ))}
              </ul>
            )}
            <div className="mt-6">
              {adding ? (
                <NoteEditor
                  initial=""
                  onDone={() => {
                    setAdding(false);
                  }}
                />
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setAdding(true);
                  }}
                >
                  <Plus />
                  {t.add}
                </Button>
              )}
            </div>
          </>
        )}
        {notes.error && <p className="mt-6 text-sm text-destructive">{t.failed}</p>}
      </main>
    </>
  );
}

/** What the learner wrote about themselves: shown as typed, with a box to write or change it. */
function AboutYou() {
  const about = useQuery(aboutQuery);
  const [editing, setEditing] = useState(false);
  const t = useT().account.notes.about;
  return (
    <section className="mt-10">
      <h2 className="font-serif text-xl font-semibold tracking-tight">{t.title}</h2>
      <p className="mt-1 max-w-prose text-sm text-muted-foreground">{t.intro}</p>
      {about.data &&
        (editing ? (
          <AboutEditor
            initial={about.data.text ?? ""}
            onDone={() => {
              setEditing(false);
            }}
          />
        ) : about.data.text ? (
          <div className="group mt-6 flex items-start gap-3">
            <p className="min-w-0 flex-1 font-serif text-[16.5px] leading-relaxed whitespace-pre-wrap">
              {about.data.text}
            </p>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t.edit}
              className="shrink-0 opacity-60 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100"
              onClick={() => {
                setEditing(true);
              }}
            >
              <Pencil />
            </Button>
          </div>
        ) : (
          <div className="mt-6">
            <p className="rounded-lg border border-dashed px-5 py-4 text-sm text-muted-foreground">
              {t.none}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-4"
              onClick={() => {
                setEditing(true);
              }}
            >
              <Pencil />
              {t.write}
            </Button>
          </div>
        ))}
      {about.error && <p className="mt-6 text-sm text-destructive">{t.failed}</p>}
    </section>
  );
}

/** Writing what the learner says about themselves; saving it empty clears it. */
function AboutEditor({ initial, onDone }: { initial: string; onDone: () => void }) {
  const [text, setText] = useState(initial);
  const save = useAboutChange();
  const { account, common } = useT();
  const t = account.notes.about;
  const submit = () => {
    save.mutate(text, { onSuccess: onDone });
  };
  return (
    <form
      className="mt-6"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Textarea
        autoFocus
        aria-label={t.title}
        value={text}
        maxLength={ABOUT_MAX}
        rows={6}
        placeholder={t.placeholder}
        onChange={(event) => {
          setText(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") onDone();
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit();
        }}
        className="font-serif text-[16.5px] leading-relaxed md:text-[16.5px]"
      />
      <div className="mt-2 flex items-center gap-2">
        <Button type="submit" size="sm" disabled={save.isPending}>
          {common.save}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          {common.cancel}
        </Button>
        {save.error && (
          <p className="text-sm text-destructive">
            {save.error instanceof ApiError ? save.error.message : t.saveFailed}
          </p>
        )}
      </div>
    </form>
  );
}

/** A note: its text, what it rests on, and changing or removing it. */
function Note({ note }: { note: TeachingNote }) {
  const [editing, setEditing] = useState(false);
  const [why, setWhy] = useState(false);
  const remove = useNoteChange();
  const t = useT().account.notes;
  const sessions = new Set(note.evidence.map((e) => e.session?.id ?? e.what)).size;
  if (editing)
    return (
      <li className="py-4">
        <NoteEditor
          id={note.id}
          initial={note.text}
          onDone={() => {
            setEditing(false);
          }}
        />
      </li>
    );
  return (
    <li className="group py-4">
      <div className="flex items-start gap-3">
        <p className="min-w-0 flex-1 font-serif text-[16.5px] leading-relaxed">{note.text}</p>
        <div className="flex shrink-0 gap-0.5 opacity-60 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:gap-2 pointer-coarse:opacity-100">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t.edit}
            onClick={() => {
              setEditing(true);
            }}
          >
            <Pencil />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t.remove}
            disabled={remove.isPending}
            onClick={() => {
              remove.mutate({ id: note.id });
            }}
          >
            <Trash2 />
          </Button>
        </div>
      </div>
      <p className="mt-1 text-[12.5px] text-subtle-foreground">
        {note.byLearner && <span>{note.evidence.length ? t.youEdited : t.youWrote}</span>}
        {note.byLearner && sessions > 0 && " · "}
        {sessions > 0 && (
          <button
            type="button"
            aria-expanded={why}
            onClick={() => {
              setWhy(!why);
            }}
            className="underline-offset-2 hover:text-foreground hover:underline"
          >
            {t.seenIn(sessions)}
          </button>
        )}
      </p>
      {why && <Evidence evidence={note.evidence} />}
      {remove.error && <p className="mt-2 text-sm text-destructive">{t.removeFailed}</p>}
    </li>
  );
}

/** Writing a note, new (no id) or changed. */
function NoteEditor({ id, initial, onDone }: { id?: string; initial: string; onDone: () => void }) {
  const [text, setText] = useState(initial);
  const save = useNoteChange();
  const { account, common } = useT();
  const t = account.notes;
  const submit = () => {
    if (!text.trim()) return;
    save.mutate({ ...(id ? { id } : {}), text }, { onSuccess: onDone });
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Textarea
        autoFocus
        aria-label={id ? t.theNote : t.aNewNote}
        value={text}
        maxLength={500}
        placeholder={t.placeholder}
        onChange={(event) => {
          setText(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") onDone();
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit();
        }}
        className="font-serif text-[16.5px] leading-relaxed md:text-[16.5px]"
      />
      <div className="mt-2 flex items-center gap-2">
        <Button type="submit" size="sm" disabled={save.isPending || !text.trim()}>
          {id ? common.save : common.add}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          {common.cancel}
        </Button>
        {save.error && (
          <p className="text-sm text-destructive">
            {save.error instanceof ApiError ? save.error.message : t.saveFailed}
          </p>
        )}
      </div>
    </form>
  );
}

/** What a note rests on: each time it was seen, and the session it was seen in. */
function Evidence({ evidence }: { evidence: TeachingNote["evidence"] }) {
  const t = useT().account.notes;
  return (
    <ul className="mt-2 space-y-1.5 border-l-2 border-primary/40 pl-3">
      {evidence.map((e, i) => (
        <li
          key={`${e.session?.id ?? ""}-${String(i)}`}
          className="text-[13px] text-muted-foreground first-letter:uppercase"
        >
          {e.what}
          {e.session && (
            <>
              {" — "}
              <Link
                to="/sessions/$sessionId"
                params={{ sessionId: e.session.id }}
                className="text-subtle-foreground underline underline-offset-2 hover:text-foreground"
              >
                {t.where(e.session.trackTitle, e.session.number)}
              </Link>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
