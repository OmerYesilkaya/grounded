import { QueryClient } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  type RouterHistory,
} from "@tanstack/react-router";
import { Shell } from "@/components/shell";
import { adminApi } from "@/lib/api";
import { validateFilters, validateSessionSearch } from "@/lib/filters";
import { LearnersPage } from "@/pages/learners";
import { OverviewPage } from "@/pages/overview";
import { SessionPage } from "@/pages/session";
import { SessionsPage } from "@/pages/sessions";

export const createQueryClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });

export const queryClient = createQueryClient();

const rootRoute = createRootRoute({
  // Whether the panel may open: signed in, and an operator (design §10.1). Asked on each load of
  // the panel, not cached: an operator removed is out at the next page.
  loader: () => adminApi.me(),
  component: Shell,
  errorComponent: Shell.Refused,
});

const overviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: validateFilters,
  component: OverviewPage,
});

export const sessionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sessions",
  validateSearch: validateSessionSearch,
  component: SessionsPage,
});

export const sessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sessions/$id",
  validateSearch: (search: Record<string, unknown>) => ({
    call: typeof search.call === "string" ? search.call : undefined,
  }),
  component: SessionPage,
});

const learnersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/learners",
  component: LearnersPage,
});

const routeTree = rootRoute.addChildren([
  overviewRoute,
  sessionsRoute,
  sessionRoute,
  learnersRoute,
]);

/** The panel's router; a test passes a memory history. */
export const createAdminRouter = (history?: RouterHistory) =>
  createRouter({ routeTree, basepath: "/admin", ...(history ? { history } : {}) });

export const router = createAdminRouter();

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
