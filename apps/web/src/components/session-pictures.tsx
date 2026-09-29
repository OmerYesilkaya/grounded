import { useQuery } from "@tanstack/react-query";
import { picturesQuery } from "@/lib/term-map";
import type { SessionModel } from "@/lib/session";
import { TermMapPicture } from "./term-map";

/** What the pictures depend on: asked again when it moves on (a plan recorded, the lesson done). */
const momentOf = (model: SessionModel) =>
  `${model.state.phase}:${model.state.plan}:${String(model.messages.filter((m) => m.kind === "plan").length)}`;

/**
 * The plan's picture of what rests on what (design §9.1), inside the latest plan's card once its
 * terms are recorded: the ideas the plan will build and what they rest on.
 */
export function PlanPicture({ model, messageId }: { model: SessionModel; messageId: string }) {
  const pictures = useQuery(picturesQuery(model.id, momentOf(model)));
  const plan = pictures.data?.plan;
  if (plan?.messageId !== messageId || plan.map.nodes.length === 0) return null;
  return (
    <figure className="mt-5 border-t pt-5">
      <figcaption className="mb-4 text-[11px] tracking-widest text-subtle-foreground uppercase">
        What rests on what
      </figcaption>
      <TermMapPicture map={plan.map} label="The ideas this plan builds, above what they rest on" />
    </figure>
  );
}

/**
 * "What you just built" (design §3.2): after the lesson's last check, its ideas above what they
 * rest on. The lesson opens with no picture, so the path is discovered first.
 */
export function BuiltPicture({ model }: { model: SessionModel }) {
  const pictures = useQuery(picturesQuery(model.id, momentOf(model)));
  const built = pictures.data?.built;
  if (!built || built.nodes.length === 0) return null;
  return (
    <figure className="mt-14 rounded-lg border bg-card px-5 pt-5 pb-4">
      <figcaption className="mb-1 font-serif text-xl font-semibold tracking-tight">
        What you just built
      </figcaption>
      <p className="mb-6 font-sans text-sm text-muted-foreground">
        Each idea from this lesson, above what it rests on.
      </p>
      <TermMapPicture map={built} label="The ideas this lesson built, above what they rest on" />
    </figure>
  );
}
