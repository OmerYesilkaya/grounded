import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { progressQuery, type Idea, type TrackProgress } from "@/lib/progress";
import { describeItem } from "@/lib/track-list";
import type { TrackItem } from "@/lib/tracks";
import { cn } from "@/lib/utils";
import { TermMapPicture } from "./term-map";

/**
 * What the learner owns and what is still settling, what the tutor will come back to, and the
 * track's map, an arc at a time (design §8). In the learner's words, never the method's.
 */
export function TrackProgressView({ trackId, items }: { trackId: string; items: TrackItem[] }) {
  const progress = useQuery(progressQuery(trackId));
  if (!progress.data) return null;
  return <Progress progress={progress.data} items={items} />;
}

type Place = "settling" | "owned" | "map";

const plural = (n: number, one: string, many: string) => `${String(n)} ${n === 1 ? one : many}`;

function Progress({ progress, items }: { progress: TrackProgress; items: TrackItem[] }) {
  // The idea opened, and where: its details open beside the list or the map it was opened from.
  const [open, setOpen] = useState<{ term: string; place: Place } | null>(null);
  const ideas = new Map([...progress.owned, ...progress.settling].map((i) => [i.term, i]));
  const chosen = open ? ideas.get(open.term) : undefined;
  const selected = open?.term ?? null;
  const choose = (place: Place) => (term: string) => {
    setOpen(open?.term === term && open.place === place ? null : { term, place });
  };
  const close = () => {
    setOpen(null);
  };
  // Every item is a session for now; count only sessions once homework and arc exams join.
  const sessionsDone = items.filter((i) => i.done).length;
  const started = sessionsDone > 0 || ideas.size > 0;

  return (
    <div className="mt-12">
      {started && (
        <dl className="grid grid-cols-3 border-y">
          <Figure value={progress.owned.length} label="ideas you own" />
          <Figure value={progress.settling.length} label="still settling" />
          <Figure
            value={sessionsDone}
            label={sessionsDone === 1 ? "session done" : "sessions done"}
          />
        </dl>
      )}

      {progress.settling.length > 0 && (
        <Section
          title="Still settling"
          note="Ideas you have met but not yet made your own. The next sessions and homework come back to them."
        >
          <Ideas ideas={progress.settling} selected={selected} onSelect={choose("settling")} />
          {chosen && open?.place === "settling" && <Detail idea={chosen} onClose={close} />}
        </Section>
      )}

      {progress.owned.length > 0 && (
        <Section title="Ideas you own" note="You have used these in your own words.">
          <Ideas ideas={progress.owned} selected={selected} onSelect={choose("owned")} />
          {chosen && open?.place === "owned" && <Detail idea={chosen} onClose={close} />}
        </Section>
      )}

      {progress.revisit.length > 0 && (
        <Section title="To revisit" note="What the tutor noticed and will come back to.">
          <ul className="space-y-2">
            {progress.revisit.map((text) => (
              <li key={text} className="flex gap-3 text-[14.5px] leading-relaxed">
                <span aria-hidden className="mt-2.5 h-px w-3 shrink-0 bg-primary" />
                {text}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {progress.arcs.length > 0 && (
        <MapSection
          progress={progress}
          selected={selected}
          onSelect={choose("map")}
          detail={chosen && open?.place === "map" ? <Detail idea={chosen} onClose={close} /> : null}
          ideas={ideas}
        />
      )}
    </div>
  );
}

/**
 * What is open in the track, each a row as the track list says it (design §9.2) that goes on with
 * it: the open session now; homework and arc exams join as kinds of their own.
 */
export function OpenWork({ items }: { items: readonly TrackItem[] }) {
  return (
    <ul className="divide-y rounded-lg border bg-card">
      {items.map((item) => {
        const { title, meta } = describeItem(item);
        return (
          <li key={item.id}>
            <Link
              to="/sessions/$sessionId"
              params={{ sessionId: item.id }}
              className="group flex items-center gap-4 px-4 py-3 transition-colors first:rounded-t-lg last:rounded-b-lg hover:bg-muted"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14.5px] font-medium">{title}</span>
                <span className="mt-0.5 block text-[12.5px] text-subtle-foreground">{meta}</span>
              </span>
              <ArrowRight className="size-4 shrink-0 text-subtle-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function Figure({ value, label }: { value: number; label: string }) {
  return (
    // The term before its value, as a list of them wants; the figure shows above it.
    <div className="flex flex-col-reverse py-4 pr-2 not-first:border-l not-first:pl-5">
      <dt className="mt-0.5 text-[12.5px] text-muted-foreground">{label}</dt>
      <dd className="font-serif text-3xl font-semibold tracking-tight tabular-nums">{value}</dd>
    </div>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="mt-12">
      <h2 className="text-xs tracking-widest text-subtle-foreground uppercase">{title}</h2>
      {note && <p className="mt-1.5 text-[13px] text-muted-foreground">{note}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** The ideas as buttons: each opens what shows where it stands. */
function Ideas({
  ideas,
  selected,
  onSelect,
}: {
  ideas: readonly Idea[];
  selected: string | null;
  onSelect: (term: string) => void;
}) {
  return (
    <ul className="flex flex-wrap gap-2">
      {ideas.map((idea) => (
        <li key={idea.term}>
          <button
            type="button"
            aria-expanded={selected === idea.term}
            onClick={() => {
              onSelect(idea.term);
            }}
            className={cn(
              "rounded-[4px] border px-2.5 py-1 text-left text-[13.5px] transition-colors hover:border-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
              idea.standing === "owned"
                ? "border-primary/40 bg-highlight"
                : "border-primary/50 bg-background",
              selected === idea.term && "border-primary ring-1 ring-primary",
            )}
          >
            {idea.term}
            {(idea.from ?? idea.brought) && (
              <span className="ml-1.5 text-[11px] text-subtle-foreground">
                {idea.from ? `from ${idea.from}` : "you brought it"}
              </span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Where an idea stands, in plain words: what showed it, when, and what it rests on. */
function Detail({ idea, onClose }: { idea: Idea; onClose: () => void }) {
  const when = new Date(idea.since).toLocaleDateString("en", { day: "numeric", month: "long" });
  const origin = idea.from
    ? `You hold it from ${idea.from}, so this track builds on it without teaching it again.`
    : idea.brought
      ? "You already knew it when this track began."
      : idea.standing === "owned"
        ? "You used it correctly in your own words."
        : "You have met it; it isn't solid yet.";
  // Opened below a map taller than the screen, it would open out of sight.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [idea.term]);
  return (
    <div ref={box} className="relative mt-4 scroll-mb-6 rounded-lg border bg-card px-5 py-4">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute top-3 right-3 rounded-md p-1 text-subtle-foreground hover:bg-muted hover:text-foreground"
      >
        <X className="size-4" />
      </button>
      <h3 className="pr-8 font-serif text-lg font-semibold">{idea.term}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{origin}</p>
      {idea.evidence && (
        <blockquote className="mt-3 border-l-2 border-primary/60 pl-3 font-serif text-[15.5px] leading-relaxed">
          {idea.evidence}
        </blockquote>
      )}
      <p className="mt-3 text-[12.5px] text-subtle-foreground">
        {idea.session ? (
          <>
            <Link
              to="/sessions/$sessionId"
              params={{ sessionId: idea.session.id }}
              className="underline underline-offset-2 hover:text-foreground"
            >
              Session {idea.session.number}
            </Link>
            {`, ${when}`}
          </>
        ) : (
          when
        )}
        {idea.restsOn.length > 0 && ` · rests on ${idea.restsOn.join(", ")}`}
      </p>
    </div>
  );
}

/** The track's map, one arc at a time: the one the track has reached first. */
function MapSection({
  progress,
  selected,
  onSelect,
  detail,
  ideas,
}: {
  progress: TrackProgress;
  selected: string | null;
  onSelect: (term: string) => void;
  /** The details of the idea opened from the map. */
  detail: ReactNode;
  ideas: Map<string, Idea>;
}) {
  const initial = Math.max(
    0,
    progress.arcs.findIndex((a) => a.current),
  );
  const [index, setIndex] = useState(initial);
  const arc = progress.arcs[index];
  if (!arc) return null;
  return (
    <Section title="The map">
      <div role="tablist" aria-label="Arcs" className="-mx-1 flex flex-wrap gap-1">
        {progress.arcs.map((a, i) => (
          <button
            key={a.title}
            type="button"
            role="tab"
            aria-selected={i === index}
            onClick={() => {
              setIndex(i);
            }}
            className={cn(
              "rounded-[4px] px-2.5 py-1 text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground",
              i === index && "bg-highlight text-primary hover:bg-highlight hover:text-primary",
            )}
          >
            {a.title}
            {a.current && <span className="ml-1.5 text-[11px] opacity-70">now</span>}
          </button>
        ))}
      </div>
      <p className="mt-3 text-[12.5px] text-subtle-foreground">
        {[
          arc.counts.owned && `${String(arc.counts.owned)} you own`,
          arc.counts.settling && `${String(arc.counts.settling)} still settling`,
          arc.counts.coming && plural(arc.counts.coming, "idea to come", "ideas to come"),
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      <div className="mt-4 rounded-lg border bg-card px-4 pt-6 pb-4">
        <TermMapPicture
          map={arc.map}
          selected={selected}
          onSelect={(node) => {
            if (ideas.has(node.term)) onSelect(node.term);
          }}
          label={`${arc.title}: its ideas above what they rest on`}
        />
      </div>
      {detail}
    </Section>
  );
}
