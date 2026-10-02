import { QueryClient } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
  useNavigate,
} from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { api, type Credential } from "@/lib/api";
import { getSession } from "@/lib/auth";
import { tracksQuery } from "@/lib/tracks";
import { ImportedLessonPage } from "./pages/imported-lesson";
import { KeySettingsPage } from "./pages/key-settings";
import { NewTrackPage } from "./pages/new-track";
import { PasswordPage } from "./pages/password";
import { SignInPage } from "./pages/sign-in";
import { TeachingNotesPage } from "./pages/teaching-notes";
import { TrackPage } from "./pages/track";
import { UsagePage } from "./pages/usage";

export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
});

async function requireSession() {
  const user = await getSession();
  if (!user) throw redirect({ to: "/sign-in" });
  return user;
}

/** Signed in with a password chosen: until then, only choosing one is open (design §4.3). */
async function requirePassword() {
  const user = await requireSession();
  if (!user.passwordSet) throw redirect({ to: "/set-password" });
  return user;
}

const rootRoute = createRootRoute({ component: Outlet });

/** Signed in, password chosen, with a key saved: the app with its track sidebar. */
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  beforeLoad: async () => {
    const user = await requirePassword();
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
    const tracks = await queryClient.query(tracksQuery);
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
  // A preview card's "Make a track about this" opens it with the goal in the box (design §6.2).
  validateSearch: (search: Record<string, unknown>): { goal?: string } =>
    typeof search.goal === "string" ? { goal: search.goal } : {},
  component: function NewTrack() {
    const { goal } = newTrackRoute.useSearch();
    return <NewTrackPage initialGoal={goal} />;
  },
});

const trackRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/tracks/$trackId",
  component: function Track() {
    const { trackId } = trackRoute.useParams();
    return <TrackPage trackId={trackId} />;
  },
});

const usageRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/usage",
  component: UsagePage,
});

const teachingNotesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/teaching-notes",
  component: TeachingNotesPage,
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

// Homework on a page of its own, with the answer editor; it loads on first visit too.
const homeworkRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/homework/$assignmentId",
  component: lazyRouteComponent(() => import("./pages/homework"), "HomeworkRoute"),
});

const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sign-in",
  beforeLoad: async () => {
    if (await getSession()) throw redirect({ to: "/" });
  },
  component: function SignIn() {
    const navigate = useNavigate();
    return <SignInPage onSignedIn={() => void navigate({ to: "/" })} />;
  },
});

const setPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/set-password",
  beforeLoad: async () => {
    const user = await requireSession();
    if (user.passwordSet) throw redirect({ to: "/" });
  },
  component: function SetPassword() {
    const navigate = useNavigate();
    return <PasswordPage change={false} onDone={() => void navigate({ to: "/" })} />;
  },
});

const changePasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/password",
  beforeLoad: requirePassword,
  component: function ChangePassword() {
    const navigate = useNavigate();
    return <PasswordPage change onDone={() => void navigate({ to: "/" })} />;
  },
});

const keySettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/key",
  beforeLoad: requirePassword,
  component: KeySettingsPage,
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([
    appRoute.addChildren([
      homeRoute,
      newTrackRoute,
      trackRoute,
      importedLessonRoute,
      sessionRoute,
      homeworkRoute,
      usageRoute,
      teachingNotesRoute,
    ]),
    signInRoute,
    setPasswordRoute,
    changePasswordRoute,
    keySettingsRoute,
  ]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
