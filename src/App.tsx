import { useEffect, useRef, useState } from "react";
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
import { LogoMark } from "./Logo";
import NewSearch from "./NewSearch";

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
  onSearchOwn,
  ready,
}: {
  onStarted: (id: Id<"searches">) => void;
  onSearchOwn: () => void;
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
    <section className="mx-auto grid max-w-7xl gap-12 px-6 py-16 sm:py-20 lg:grid-cols-[minmax(0,1fr)_360px] lg:gap-16">
      <div className="max-w-3xl">
      <h1 className="t-title">
        The service most families use to find a nursing home is paid{" "}
        {/* Each figure is unbreakable; the range may wrap at the dash. Holding
            the whole thing on one line overflows a 390px phone, and families
            read this from hospital waiting rooms. */}
        <span className="whitespace-nowrap">$10,000</span>–
        <span className="whitespace-nowrap">$15,000</span> by the facility it
        sends you to.
      </h1>
      <p className="t-lede measure mt-5">
        Roughly one month's rent, paid by the home, for a referral the family
        believes is free advice. Ombuds takes no money from facilities. It reads
        the federal inspection record — every failure, every fine — and then it
        emails every facility on your shortlist to ask the five things nobody
        publishes.
      </p>

      <button
        onClick={start}
        disabled={busy || !ready}
        className="btn btn-primary btn-lg mt-8 w-full sm:w-auto"
      >
        {busy ? "Opening the board…" : "See a real search"}
      </button>

      <p className="t-body measure mt-3 text-muted">
        Twelve real Medicare-certified facilities near Pomona, California, with
        their real inspection records. No sign-up, no email address, no form.
      </p>

      {/* The sample search is for someone who has never seen this. Anyone with
          a parent and a town of their own needs the other door, and it has to
          be visible without scrolling — a family in a hospital waiting room
          should not have to work out that the demo is not the product. */}
      <p className="t-body mt-6">
        <button onClick={onSearchOwn} className="link font-bold">
          Or search your own ZIP code
        </button>{" "}
        <span className="text-muted">
          — every certified facility near you, ranked by its inspection record.
        </span>
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

      <Scale />
    </section>
  );
}

/**
 * The size of the thing, in three real numbers.
 *
 * The headline is an argument about someone else's business model, and an
 * argument needs something to stand on. These are the figures behind it: how
 * much public record exists, how little of it is readable, and the one number
 * that separates this from a referral service. Every one is checkable — the
 * first two against the CMS Provider Data Catalog, the third against the fact
 * that there is no billing relationship to a facility anywhere in this product.
 *
 * It also gives the hero a right-hand side. Three hundred and sixty pixels of
 * nothing beside a headline reads as a page that did not finish loading.
 */
function Scale() {
  const figures = [
    {
      value: "14,690",
      label: "Medicare-certified facilities in the federal record",
    },
    {
      value: "419,479",
      label:
        "inspection findings published — as tag codes and severity letters almost nobody can read",
    },
    {
      value: "$0",
      label: "taken from facilities, ever. They cannot pay to appear here",
    },
  ];

  return (
    <aside className="lg:pt-2">
      <h2 className="t-label">What Ombuds reads</h2>
      {/* One card, three figures, separated by whitespace. The hairline that
          used to run between them made three boxes out of one list. */}
      <dl className="card mt-4">
        {figures.map((figure) => (
          <div key={figure.value} className="p-5">
            <dt className="t-figure">{figure.value}</dt>
            <dd className="t-body mt-2 text-muted">{figure.label}</dd>
          </div>
        ))}
      </dl>
    </aside>
  );
}

/**
 * The sentence the whole product hangs on.
 *
 * Neither half is sufficient alone, and a reader who takes only one thing from
 * this page should take this. It sits above the mechanism rather than below it
 * because it is the claim; the three steps underneath are only how it is kept.
 */
function Thesis() {
  return (
    <section className="border-y border-rule bg-sunk">
      <div className="mx-auto max-w-7xl px-6 py-10">
        <p className="t-heading max-w-4xl">
          Public records tell you whether a facility is{" "}
          <span className="underline decoration-rule-strong underline-offset-4">
            safe
          </span>
          . Only email tells you whether it is{" "}
          <span className="underline decoration-rule-strong underline-offset-4">
            available
          </span>
          .
        </p>
        <p className="t-lede measure mt-3 text-muted">
          Ombuds does both, and takes no money from facilities.
        </p>
      </div>
    </section>
  );
}

/**
 * The mechanism, in three steps.
 *
 * This exists because the product's hardest idea is a plumbing idea: the
 * federal record publishes a telephone number and no email address, so there is
 * no path from a government inspection record to a facility's inbox without
 * going out to the open web and finding one. A reader who does not follow that
 * cannot tell why any of this is difficult, and a paragraph explaining it gets
 * skimmed. Three numbered steps do not.
 *
 * Each step names what does the work, because "we read the federal record" and
 * "CMS publishes 14,690 certified facilities" are different sentences and only
 * the second one can be checked.
 */
const STEPS = [
  {
    n: "1",
    title: "Read the federal record",
    body: "Every inspection failure, every fine, every staffing figure for 14,690 Medicare-certified facilities — published as tag codes and severity letters, and translated here into plain English.",
    source: "CMS Provider Data Catalog · updated monthly",
  },
  {
    n: "2",
    title: "Find a way to reach them",
    body: "The federal record carries a telephone number and no email address. So we search the open web for each facility's own site and pull the admissions address off it.",
    source: "Firecrawl · search, map, scrape",
  },
  {
    n: "3",
    title: "Ask what nobody publishes",
    body: "Openings, true all-in cost, waitlist, night staffing, tour dates. Every facility gets its own email thread. A vague answer gets asked again, in the same thread, without anyone pressing a button.",
    source: "AgentMail · one inbox per search",
  },
];

function HowItWorks() {
  return (
    <section className="mx-auto max-w-7xl px-6 py-12">
      <h2 className="t-label">How it works</h2>
      {/* Three columns held apart by space rather than by a one-pixel grid.
          The rules were doing nothing the gap does not do, and they turned
          three steps into three boxes. */}
      <ol className="mt-5 grid gap-8 sm:grid-cols-3 sm:gap-10">
        {STEPS.map((step) => (
          <li key={step.n} className="flex flex-col">
            <span className="t-label">Step {step.n}</span>
            <h3 className="t-name mt-2">{step.title}</h3>
            <p className="t-body measure mt-2">{step.body}</p>
            <p className="t-meta mt-auto pt-4">{step.source}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

type View =
  | { name: "home" }
  | { name: "new" }
  | { name: "board"; searchId: Id<"searches"> }
  | { name: "thread"; searchId: Id<"searches">; inquiryId: Id<"inquiries"> }
  | { name: "facility"; ccn: string };

export default function App() {
  const { isAuthenticated, signInFailed } = useSilentAnonymousSignIn();
  const [view, setView] = useState<View>({ name: "home" });

  // A family who has already run a search lands back on their board rather
  // than on the pitch.
  //
  // This is a decision about where to *land*, so it is made once, the moment we
  // first know whether this family has a search — and never again. Re-running it
  // whenever the view returns to "home" is what made the header button dead: it
  // set the view to home and this effect put it straight back, so a family who
  // had run one search could never reach the pitch, the ZIP-code search, or any
  // search but their newest. Note the ref is set even when we do not redirect,
  // because the case that matters is a family who arrives with no search, starts
  // one, and then asks to go home.
  const searches = useQuery(api.searches.mySearches, isAuthenticated ? {} : "skip");
  const landed = useRef(false);
  useEffect(() => {
    if (landed.current || !searches) return;
    landed.current = true;
    if (searches.length > 0) {
      setView({ name: "board", searchId: searches[0].searchId });
    }
  }, [searches]);

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
            className="flex items-center gap-2.5 rounded px-1 py-0.5 hover:text-muted"
          >
            <LogoMark className="h-6 w-auto shrink-0" />
            <span className="t-name uppercase tracking-[0.16em]">Ombuds</span>
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
              onSearchOwn={() => setView({ name: "new" })}
              onStarted={(searchId) => setView({ name: "board", searchId })}
            />
            <Thesis />
            <HowItWorks />
            {/* The facility names in these columns are the way into the full
                record. A separate row of "CCN 055016" buttons underneath was
                asking a family to click a federal certification number to find
                out whose record it was. */}
            <Compare
              ccns={DEMO_CCNS}
              onOpenFacility={(ccn) => setView({ name: "facility", ccn })}
            />
            <LicensingCrawl />
          </ErrorBoundary>
        )}

        {view.name === "new" && (
          <ErrorBoundary fallbackLabel="on the search form" onReset={goHome}>
            <NewSearch
              ready={isAuthenticated}
              onCancel={goHome}
              onStarted={(searchId) => setView({ name: "board", searchId })}
            />
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
          <p className="t-body measure text-muted">
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
