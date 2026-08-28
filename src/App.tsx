import { useEffect } from "react";
import { useConvexAuth } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";

/**
 * Skeleton only — no product features yet.
 *
 * The one behaviour that is real: anonymous sign-in fires silently on mount, so
 * a judge opening the live URL never sees a login form (CLAUDE.md section 7.2).
 */
function SilentAnonymousSignIn() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const { signIn } = useAuthActions();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      void signIn("anonymous");
    }
  }, [isLoading, isAuthenticated, signIn]);

  return null;
}

export default function App() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  return (
    <>
      <SilentAnonymousSignIn />
      <main className="mx-auto max-w-3xl px-6 py-20">
        <p className="text-sm font-medium uppercase tracking-widest text-[#5b6570]">
          Ombuds
        </p>
        <h1 className="mt-4 text-4xl font-semibold leading-tight">
          Public records tell you whether a facility is safe.
          <br />
          Only email tells you whether it is available.
        </h1>
        <p className="mt-6 max-w-xl text-lg text-[#5b6570]">
          Scaffold is up. No features yet.
        </p>
        <dl className="mt-10 border-t border-[#d8dce1] pt-6 text-sm">
          <div className="flex gap-3 py-1">
            <dt className="w-40 text-[#5b6570]">Backend</dt>
            <dd>{isLoading ? "connecting…" : "connected"}</dd>
          </div>
          <div className="flex gap-3 py-1">
            <dt className="w-40 text-[#5b6570]">Anonymous session</dt>
            <dd>{isAuthenticated ? "signed in" : "signing in…"}</dd>
          </div>
        </dl>
      </main>
    </>
  );
}
