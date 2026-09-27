import { QueryClient } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import type { TrackSummary } from "@/components/track-sidebar";
import { api, type Credential } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { ImportedLessonPage } from "./pages/imported-lesson";
import { KeySettingsPage } from "./pages/key-settings";
import { NewTrackPage } from "./pages/new-track";
import { SignInPage } from "./pages/sign-in";
import { TrackPage } from "./pages/track";

export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
});

async function requireSession() {
  const { data } = await authClient.getSession();
  if (!data) throw redirect({ to: "/sign-in" });
  return data.user;
}

const rootRoute = createRootRoute({ component: Outlet });

/** Signed in, with a key saved: the app with its track sidebar. */
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  beforeLoad: async () => {
    const user = await requireSession();
    const credential = await queryClient.query({
      queryKey: ["credential"],
      queryFn: () => api<Credential | null>("/api/credentials"),
    });
    if (!credential) throw redirect({ to: "/settings/key" });
    return { user };
  },
  component: function App() {
    const { user } = appRoute.useRouteContext();
    return <AppShell email={user.email} />;
  },
});

const homeRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  beforeLoad: async () => {
    const tracks = await queryClient.query({
      queryKey: ["tracks"],
      queryFn: () => api<TrackSummary[]>("/api/tracks"),
    });
    const [first] = tracks;
    if (!first) throw redirect({ to: "/tracks/new" });
    if (first.openSession)
      throw redirect({ to: "/sessions/$sessionId", params: { sessionId: first.openSession.id } });
    throw redirect({ to: "/tracks/$trackId", params: { trackId: first.id } });
  },
});

const newTrackRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/tracks/new",
  component: NewTrackPage,
});

const trackRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/tracks/$trackId",
  component: function Track() {
    const { trackId } = trackRoute.useParams();
    return <TrackPage trackId={trackId} />;
  },
});

const importedLessonRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/tracks/$trackId/last-lesson",
  component: function ImportedLesson() {
    const { trackId } = importedLessonRoute.useParams();
    return <ImportedLessonPage trackId={trackId} />;
  },
});

// The session page carries the lesson renderer; it loads on first visit. It reads its own params.
const sessionRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/sessions/$sessionId",
  component: lazyRouteComponent(() => import("./pages/session"), "SessionRoute"),
});

const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sign-in",
  beforeLoad: async () => {
    const { data } = await authClient.getSession();
    if (data) throw redirect({ to: "/" });
  },
  component: SignInPage,
});

const keySettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/key",
  beforeLoad: requireSession,
  component: KeySettingsPage,
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([
    appRoute.addChildren([homeRoute, newTrackRoute, trackRoute, importedLessonRoute, sessionRoute]),
    signInRoute,
    keySettingsRoute,
  ]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
