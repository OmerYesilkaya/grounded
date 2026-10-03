import { Link, Outlet, type ErrorComponentProps } from "@tanstack/react-router";
import { ApiError } from "@/lib/api";

/** The app's sign-in: the panel has none of its own (design §10.1). */
const SIGN_IN = import.meta.env.DEV ? "http://localhost:5173/sign-in" : "/sign-in";

const NAV = [
  { to: "/", label: "Overview" },
  { to: "/sessions", label: "Sessions" },
  { to: "/learners", label: "Learners" },
] as const;

export function Shell() {
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur">
        <nav className="mx-auto flex max-w-7xl items-center gap-1 px-4 py-3 sm:px-6">
          <span className="mr-4 text-sm font-semibold tracking-wide">
            Grounded <span className="text-muted-foreground">admin</span>
          </span>
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              activeOptions={{ exact: item.to === "/", includeSearch: false }}
              className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground data-[status=active]:bg-muted data-[status=active]:text-foreground"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        <Outlet />
      </main>
    </div>
  );
}

/** Signed out, or not an operator: the panel says which and opens nothing. */
Shell.Refused = function Refused({ error }: ErrorComponentProps) {
  const status = error instanceof ApiError ? error.status : null;
  return (
    <div className="mx-auto mt-24 max-w-md px-4 text-center">
      <h1 className="text-lg font-semibold">
        {status === 401
          ? "Sign in to Grounded first"
          : status === 404
            ? "This account isn't an operator"
            : "The admin panel couldn't load"}
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {status === 401 ? (
          <>
            The admin panel uses the app's sign-in.{" "}
            <a className="text-primary underline" href={SIGN_IN}>
              Sign in
            </a>
            , then come back here.
          </>
        ) : status === 404 ? (
          "Run `pnpm cli operator add <email>` for it in the API service."
        ) : error instanceof Error ? (
          error.message
        ) : (
          String(error)
        )}
      </p>
    </div>
  );
};
