import { QueryClient } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { api, type Credential } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { HomePage } from "./pages/home";
import { KeySettingsPage } from "./pages/key-settings";
import { SignInPage } from "./pages/sign-in";

export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
});

async function requireSession() {
  const { data } = await authClient.getSession();
  if (!data) throw redirect({ to: "/sign-in" });
  return data.user;
}

const rootRoute = createRootRoute({ component: Outlet });

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: async () => {
    const user = await requireSession();
    const credential = await queryClient.query({
      queryKey: ["credential"],
      queryFn: () => api<Credential | null>("/api/credentials"),
    });
    if (!credential) throw redirect({ to: "/settings/key" });
    return { user };
  },
  component: function Home() {
    const { user } = homeRoute.useRouteContext();
    return <HomePage email={user.email} />;
  },
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
  routeTree: rootRoute.addChildren([homeRoute, signInRoute, keySettingsRoute]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
