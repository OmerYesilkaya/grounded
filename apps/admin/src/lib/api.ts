import type {
  CallDetail,
  FilterOptions,
  LearnerRow,
  Overview,
  Replay,
  SessionsPage,
} from "@grounded/core/admin";

/** A failed request to the API: its status says why (401 signed out, 404 not an operator). */
export class ApiError extends Error {
  constructor(readonly status: number) {
    super(`The API answered ${String(status)}.`);
  }
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin" });
  if (!response.ok) throw new ApiError(response.status);
  return (await response.json()) as T;
}

/** A query string from the values that are set, in a stable order. */
export function queryString(values: Record<string, string | number | undefined | null>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values).sort(([a], [b]) => a.localeCompare(b)))
    if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  const text = params.toString();
  return text ? `?${text}` : "";
}

export const adminApi = {
  me: () => get<{ email: string }>("/api/admin/me"),
  filters: () => get<FilterOptions>("/api/admin/filters"),
  overview: (query: string) => get<Overview>(`/api/admin/overview${query}`),
  sessions: (query: string) => get<SessionsPage>(`/api/admin/sessions${query}`),
  session: (id: string) => get<Replay>(`/api/admin/sessions/${id}`),
  call: (id: string) => get<CallDetail>(`/api/admin/calls/${id}`),
  learners: () => get<LearnerRow[]>("/api/admin/learners"),
  learnerEmail: (learner: number) =>
    get<{ email: string }>(`/api/admin/learners/${String(learner)}/email`),
};
