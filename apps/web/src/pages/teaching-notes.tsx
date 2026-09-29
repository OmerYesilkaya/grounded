import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ApiError } from "@/lib/api";
import { teachingNotesQuery, useNoteChange, type TeachingNote } from "@/lib/teaching-notes";

/**
 * The learner's teaching notes (design §8): what the tutor has noticed about how they learn, which
 * every call reads. The learner can change or remove any note, and add their own.
 */
export function TeachingNotesPage() {
  const notes = useQuery(teachingNotesQuery);
  const [adding, setAdding] = useState(false);
  return (
    <main className="mx-auto w-full max-w-2xl px-6 pt-24 pb-24">
      <p className="text-xs tracking-widest text-subtle-foreground uppercase">Teaching notes</p>
      <h1 className="mt-1 font-serif text-3xl font-semibold tracking-tight">How you learn</h1>
      <p className="mt-2 max-w-prose text-sm text-muted-foreground">
        What the tutor has noticed helps you learn, across your tracks. It reads these before every
        lesson and check. Change anything that doesn&apos;t sound like you.
      </p>
      {notes.data && (
        <>
          {notes.data.length === 0 && !adding && (
            <p className="mt-10 rounded-lg border border-dashed px-5 py-4 text-sm text-muted-foreground">
              Nothing yet. After about six sessions the tutor starts noting what helps you, each
              note resting on at least three of them.
            </p>
          )}
          {notes.data.length > 0 && (
            <ul className="mt-10 divide-y border-y">
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
                Add a note
              </Button>
            )}
          </div>
        </>
      )}
      {notes.error && (
        <p className="mt-10 text-sm text-destructive">Your notes couldn&apos;t be loaded.</p>
      )}
    </main>
  );
}

/** A note: its text, what it rests on, and changing or removing it. */
function Note({ note }: { note: TeachingNote }) {
  const [editing, setEditing] = useState(false);
  const [why, setWhy] = useState(false);
  const remove = useNoteChange();
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
        <div className="flex shrink-0 gap-0.5 opacity-60 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Edit this note"
            onClick={() => {
              setEditing(true);
            }}
          >
            <Pencil />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Remove this note"
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
        {note.byLearner && (
          <span>{note.evidence.length ? "You edited this" : "You wrote this"}</span>
        )}
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
            Seen in {sessions} {sessions === 1 ? "session" : "sessions"}
          </button>
        )}
      </p>
      {why && <Evidence evidence={note.evidence} />}
      {remove.error && (
        <p className="mt-2 text-sm text-destructive">It couldn&apos;t be removed.</p>
      )}
    </li>
  );
}

/** Writing a note, new (no id) or changed. */
function NoteEditor({ id, initial, onDone }: { id?: string; initial: string; onDone: () => void }) {
  const [text, setText] = useState(initial);
  const save = useNoteChange();
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
        aria-label={id ? "The note" : "A new note"}
        value={text}
        maxLength={500}
        placeholder="For example: a picture first, then the words."
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
          {id ? "Save" : "Add"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
        {save.error && (
          <p className="text-sm text-destructive">
            {save.error instanceof ApiError ? save.error.message : "It couldn't be saved."}
          </p>
        )}
      </div>
    </form>
  );
}

/** What a note rests on: each time it was seen, and the session it was seen in. */
function Evidence({ evidence }: { evidence: TeachingNote["evidence"] }) {
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
                {e.session.trackTitle}, session {e.session.number}
              </Link>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
