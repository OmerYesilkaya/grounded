import { useQuery } from "@tanstack/react-query";
import { adminApi } from "@/lib/api";
import { PERIODS, type Filters } from "@/lib/filters";
import { when } from "@/lib/format";

const select =
  "h-8 rounded-md border border-border-strong bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** The period, model and method version every view filters by (design §10.1), in one row. */
export function FilterBar({
  filters,
  onChange,
}: {
  filters: Filters;
  onChange: (next: Filters) => void;
}) {
  const options = useQuery({ queryKey: ["filters"], queryFn: adminApi.filters });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        aria-label="Period"
        className={select}
        value={String(filters.period ?? 30)}
        onChange={(e) => {
          const period = PERIODS.find((p) => String(p.value) === e.target.value)?.value;
          onChange({ ...filters, period });
        }}
      >
        {PERIODS.map((p) => (
          <option key={p.value} value={String(p.value)}>
            {p.label}
          </option>
        ))}
      </select>
      <select
        aria-label="Model"
        className={select}
        value={filters.model ?? ""}
        onChange={(e) => {
          onChange({ ...filters, model: e.target.value || undefined });
        }}
      >
        <option value="">Every model</option>
        {options.data?.models.map((m) => (
          <option key={m.model} value={m.model}>
            {m.model} ({m.calls})
          </option>
        ))}
      </select>
      <select
        aria-label="Method version"
        className={select}
        value={filters.method ?? ""}
        onChange={(e) => {
          onChange({ ...filters, method: e.target.value || undefined });
        }}
      >
        <option value="">Every method version</option>
        {options.data?.methods.map((m) => (
          <option key={m.version} value={m.version}>
            {m.version} · {when(m.firstSeen)} – {when(m.lastSeen)} ({m.calls})
          </option>
        ))}
      </select>
    </div>
  );
}
