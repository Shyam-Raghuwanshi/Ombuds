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

/**
 * Anonymous sign-in fires silently on mount, so a judge opening the live URL
 * never sees a login form (CLAUDE.md section 7.2).
 */
function useSilentAnonymousSignIn() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const { signIn } = useAuthActions();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) void signIn("anonymous");
  }, [isLoading, isAuthenticated, signIn]);

  return isAuthenticated;
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
 */
function ColdOpen({ onStarted }: { onStarted: (id: Id<"searches">) => void }) {
  const run = useAction(api.searches.runSampleSearch);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <section className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-[32px] font-semibold leading-tight">
        The service most families use to find a nursing home is paid{" "}
        <span className="whitespace-nowrap">$10,000–$15,000</span> by the
        facility it sends you to.
      </h1>
      <p className="mt-4 text-[18px] leading-relaxed">
        Roughly one month's rent, paid by the home, for a referral the family
        believes is free advice. Ombuds takes no money from facilities. It reads
        the federal inspection record — every failure, every fine — and then it
        emails every facility on your shortlist to ask the five things nobody
        publishes.
      </p>

      <button
        onClick={() => {
          setBusy(true);
          setError(null);
          void run({})
            .then((r) => onStarted(r.searchId))
            .catch((e) => setError(String(e)))
            .finally(() => setBusy(false));
        }}
        disabled={busy}
        className="mt-8 rounded bg-[#14171a] px-5 py-3 text-[17px] font-medium text-white disabled:opacity-60 dark:bg-[#e8ebee] dark:text-[#101315]"
      >
        {busy ? "Opening a search…" : "See a real search"}
      </button>

      <p className="mt-3 text-[14px] text-[#5b6570] dark:text-[#9aa4ad]">
        Twelve real Medicare-certified facilities near Pomona, California, with
        their real inspection records. No sign-up.
      </p>

      {error && (
        <p className="mt-4 rounded border border-[#d8dce1] p-3 text-[15px] dark:border-[#2b3236]">
          We could not open the sample search: {error}
        </p>
      )}
    </section>
  );
}

type View =
  | { name: "home" }
  | { name: "board"; searchId: Id<"searches"> }
  | { name: "thread"; searchId: Id<"searches">; inquiryId: Id<"inquiries"> }
  | { name: "facility"; ccn: string };

export default function App() {
  const isAuthenticated = useSilentAnonymousSignIn();
  const [view, setView] = useState<View>({ name: "home" });

  // A family who has already run a search lands back on their board rather
  // than on the pitch.
  const searches = useQuery(api.searches.mySearches, isAuthenticated ? {} : "skip");
  useEffect(() => {
    if (view.name === "home" && searches && searches.length > 0) {
      setView({ name: "board", searchId: searches[0].searchId });
    }
  }, [searches, view.name]);

  return (
    <>
      <header className="border-b border-[#d8dce1] px-6 py-4 dark:border-[#2b3236]">
        <button
          onClick={() => setView({ name: "home" })}
          className="text-sm font-medium uppercase tracking-widest text-[#5b6570] dark:text-[#9aa4ad]"
        >
          Ombuds
        </button>
      </header>

      <main>
        {view.name === "home" && (
          <>
            <ColdOpen
              onStarted={(searchId) => setView({ name: "board", searchId })}
            />
            <Compare ccns={DEMO_CCNS} />
            <nav className="mx-auto max-w-7xl px-6 pb-16">
              <h2 className="text-[15px] font-medium">Open the full record</h2>
              <ul className="mt-2 flex flex-wrap gap-3">
                {DEMO_CCNS.map((ccn) => (
                  <li key={ccn}>
                    <button
                      onClick={() => setView({ name: "facility", ccn })}
                      className="rounded border border-[#d8dce1] px-3 py-1.5 text-[15px] underline underline-offset-4 dark:border-[#2b3236]"
                    >
                      CCN {ccn}
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
            <LicensingCrawl />
          </>
        )}

        {view.name === "board" && (
          <Board
            searchId={view.searchId}
            onOpenThread={(inquiryId) =>
              setView({ name: "thread", searchId: view.searchId, inquiryId })
            }
          />
        )}

        {view.name === "thread" && (
          <ThreadView
            inquiryId={view.inquiryId}
            onBack={() => setView({ name: "board", searchId: view.searchId })}
          />
        )}

        {view.name === "facility" && (
          <FacilityDetail
            ccn={view.ccn}
            onBack={() => setView({ name: "home" })}
          />
        )}
      </main>

      <footer className="border-t border-[#d8dce1] px-6 py-6 text-[14px] text-[#5b6570] dark:border-[#2b3236] dark:text-[#9aa4ad]">
        Inspection data is the public federal record from the CMS Provider Data
        Catalog. Plain-English explanations are generated from that record and
        labelled with the model that wrote them. Answers about openings, cost,
        waitlists, and staffing are what facilities told us by email, labelled
        with the date they told us. Ombuds reports public records and relays
        what facilities tell us. It is not medical, legal, or financial advice,
        and we take no money from facilities.
      </footer>
    </>
  );
}
