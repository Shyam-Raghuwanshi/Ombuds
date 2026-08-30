import { useEffect, useState } from "react";
import { useAction, useConvexAuth, useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { Board } from "./Board";
import { ThreadView } from "./ThreadView";
import { Compare } from "./Compare";
import { FacilityDetail } from "./FacilityDetail";
import { LicensingCrawl } from "./LicensingCrawl";
import { ErrorBoundary, ErrorState, Loading, ThemeToggle } from "./ui";

/**
 * Anonymous sign-in fires silently on mount, so a judge opening the live URL
 * never sees a login form (CLAUDE.md section 7.2).
 *
 * It starts the moment the page does rather than on the button, so by the time
 * anyone has read the headline and reached for the mouse the session already
 * exists and the click costs nothing.
 */
function useSilentAnonymousSignIn() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const { signIn } = useAuthActions();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      void signIn("anonymous").catch((e) => {
        console.error("anonymous sign-in failed", e);
        setFailed(true);
      });
    }
  }, [isLoading, isAuthenticated, signIn]);

  return { isAuthenticated, signInFailed: failed && !isAuthenticated };
}

/**
 * Three real, Medicare-certified California nursing homes, chosen because
 * their federal inspection records are genuinely different from one another:
 *
 *   055016  Mount San Antonio Gardens  14 findings, none harmed anyone
 *   055085  Moraga Post Acute          one isolated actual-harm fall, corrected
 *   056487  Rio Hondo Subacute         196 findings, 5 immediate jeopardy,
 *                                      the same failures every year since 2023
 */
const DEMO_CCNS = ["055016", "055085", "056487"];

/**
 * The cold open. One button, no form, no account.
 *
 * A judge who has never seen this product opens the URL, presses one thing, and
 * inside a minute is watching twelve real facilities' inspection records on the
 * left and twelve live email conversations filling in on the right.
 *
 * The button does not wait for the campaign. `runSampleSearch` returns as soon
 * as the search exists and hands the fan-out to the scheduler, so the board is
 * on screen in about a second and the letters are drafted and sent while the
 * judge is already reading real inspection records. Waiting for a model to
 * write a letter before showing anything would spend a third of the sixty
 * seconds on a spinner.
 */
function ColdOpen({
  onStarted,
  ready,
}: {
  onStarted: (id: Id<"searches">) => void;
  ready: boolean;
}) {
  const run = useAction(api.searches.runSampleSearch);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function start() {
    setBusy(true);
    setError(null);
    void run({})
      .then((r) => onStarted(r.searchId))
      .catch((e) => {
        console.error("sample search failed", e);
        setError(
          "We could not open the sample search just now. This is our backend, not your connection — pressing the button again usually works.",
        );
      })
      .finally(() => setBusy(false));
  }

  return (
    <section className="mx-auto max-w-7xl px-6 py-16 sm:py-20">
      <div className="max-w-3xl">
      <h1 className="text-[30px] font-semibold leading-tight sm:text-[38px]">
        The service most families use to find a nursing home is paid{" "}
        {/* Each figure is unbreakable; the range may wrap at the dash. Holding
            the whole thing on one line overflows a 390px phone, and families
            read this from hospital waiting rooms. */}
        <span className="whitespace-nowrap">$10,000</span>–
        <span className="whitespace-nowrap">$15,000</span> by the facility it
        sends you to.
      </h1>
      <p className="mt-5 max-w-2xl text-[18px] leading-relaxed">
        Roughly one month's rent, paid by the home, for a referral the family
        believes is free advice. Ombuds takes no money from facilities. It reads
        the federal inspection record — every failure, every fine — and then it
        emails every facility on your shortlist to ask the five things nobody
        publishes.
      </p>

      <button
        onClick={start}
        disabled={busy || !ready}
        className="mt-8 w-full rounded bg-ink px-6 py-4 text-[18px] font-semibold text-paper disabled:opacity-60 sm:w-auto"
      >
        {busy ? "Opening the board…" : "See a real search"}
      </button>

      <p className="mt-3 text-[16px] text-muted">
        Twelve real Medicare-certified facilities near Pomona, California, with
        their real inspection records. No sign-up, no email address, no form.
      </p>

      {!ready && !error && (
        <div className="mt-4">
          <Loading what="Signing you in anonymously…" />
        </div>
      )}

      {error && (
        <div className="mt-6">
          <ErrorState
            title="The sample search did not open."
            detail={error}
            onRetry={start}
          />
        </div>
      )}
      </div>
    </section>
  );
}

type View =
  | { name: "home" }
  | { name: "board"; searchId: Id<"searches"> }
  | { name: "thread"; searchId: Id<"searches">; inquiryId: Id<"inquiries"> }
  | { name: "facility"; ccn: string };

export default function App() {
  const { isAuthenticated, signInFailed } = useSilentAnonymousSignIn();
  const [view, setView] = useState<View>({ name: "home" });

  // A family who has already run a search lands back on their board rather
  // than on the pitch.
  const searches = useQuery(api.searches.mySearches, isAuthenticated ? {} : "skip");
  useEffect(() => {
    if (view.name === "home" && searches && searches.length > 0) {
      setView({ name: "board", searchId: searches[0].searchId });
    }
  }, [searches, view.name]);

  const goHome = () => setView({ name: "home" });

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to the main content
      </a>

      <header className="border-b border-rule">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-6 py-4">
          <button
            onClick={goHome}
            className="text-[15px] font-semibold uppercase tracking-widest"
          >
            Ombuds
            <span className="sr-only"> — back to the start</span>
          </button>
          <ThemeToggle />
        </div>
      </header>

      <main id="main">
        {signInFailed && (
          <div className="mx-auto max-w-7xl px-6 pt-8">
            <ErrorState
              title="We could not start a session for you."
              detail="Ombuds signs every visitor in anonymously so there is never a form to fill in. That call did not go through, so nothing below can load. Reloading the page usually fixes it."
              onRetry={() => window.location.reload()}
            />
          </div>
        )}

        {view.name === "home" && (
          <ErrorBoundary fallbackLabel="on the front page" onReset={goHome}>
            <ColdOpen
              ready={isAuthenticated}
              onStarted={(searchId) => setView({ name: "board", searchId })}
            />
            <Compare ccns={DEMO_CCNS} />
            <nav className="mx-auto max-w-7xl px-6 pb-16">
              <h2 className="text-[16px] font-medium">Open the full record</h2>
              <ul className="mt-3 flex flex-wrap gap-3">
                {DEMO_CCNS.map((ccn) => (
                  <li key={ccn}>
                    <button
                      onClick={() => setView({ name: "facility", ccn })}
                      className="rounded border border-rule-strong px-4 py-2 text-[16px]"
                    >
                      CCN {ccn}
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
            <LicensingCrawl />
          </ErrorBoundary>
        )}

        {view.name === "board" && (
          <ErrorBoundary fallbackLabel="on the board" onReset={goHome}>
            <Board
              searchId={view.searchId}
              onOpenThread={(inquiryId) =>
                setView({ name: "thread", searchId: view.searchId, inquiryId })
              }
              onOpenFacility={(ccn) => setView({ name: "facility", ccn })}
            />
          </ErrorBoundary>
        )}

        {view.name === "thread" && (
          <ErrorBoundary fallbackLabel="on this conversation" onReset={goHome}>
            <ThreadView
              inquiryId={view.inquiryId}
              onBack={() => setView({ name: "board", searchId: view.searchId })}
            />
          </ErrorBoundary>
        )}

        {view.name === "facility" && (
          <ErrorBoundary fallbackLabel="on this facility" onReset={goHome}>
            <FacilityDetail ccn={view.ccn} onBack={goHome} />
          </ErrorBoundary>
        )}
      </main>

      <footer className="mt-16 border-t border-rule">
        <div className="mx-auto max-w-7xl px-6 py-8">
          <p className="max-w-3xl text-[16px] leading-relaxed text-muted">
            Inspection data is the public federal record from the CMS Provider
            Data Catalog. Plain-English explanations are generated from that
            record and labelled with the model that wrote them. Answers about
            openings, cost, waitlists, and staffing are what facilities told us
            by email, labelled with the date they told us. Ombuds reports
            public records and relays what facilities tell us. It is not
            medical, legal, or financial advice, and we take no money from
            facilities.
          </p>
        </div>
      </footer>
    </>
  );
}
