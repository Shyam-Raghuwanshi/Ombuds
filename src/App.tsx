import { useEffect, useState } from "react";
import { useConvexAuth } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { Compare } from "./Compare";
import { FacilityDetail } from "./FacilityDetail";
import { LicensingCrawl } from "./LicensingCrawl";

/**
 * Anonymous sign-in fires silently on mount, so a judge opening the live URL
 * never sees a login form (CLAUDE.md section 7.2).
 */
function SilentAnonymousSignIn() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const { signIn } = useAuthActions();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) void signIn("anonymous");
  }, [isLoading, isAuthenticated, signIn]);

  return null;
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

export default function App() {
  const [open, setOpen] = useState<string | null>(null);

  return (
    <>
      <SilentAnonymousSignIn />
      <header className="border-b border-[#d8dce1] px-6 py-4 dark:border-[#2b3236]">
        <p className="text-sm font-medium uppercase tracking-widest text-[#5b6570] dark:text-[#9aa4ad]">
          Ombuds
        </p>
      </header>

      <main>
        {open ? (
          <FacilityDetail ccn={open} onBack={() => setOpen(null)} />
        ) : (
          <>
            <Compare ccns={DEMO_CCNS} />
            <nav className="mx-auto max-w-7xl px-6 pb-16">
              <h2 className="text-[15px] font-medium">Open the full record</h2>
              <ul className="mt-2 flex flex-wrap gap-3">
                {DEMO_CCNS.map((ccn) => (
                  <li key={ccn}>
                    <button
                      onClick={() => setOpen(ccn)}
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
      </main>

      <footer className="border-t border-[#d8dce1] px-6 py-6 text-[14px] text-[#5b6570] dark:border-[#2b3236] dark:text-[#9aa4ad]">
        Inspection data is the public federal record from the CMS Provider Data
        Catalog. Plain-English explanations are generated from that record and
        labelled with the model that wrote them. Ombuds reports public records
        and relays what facilities tell us. It is not medical, legal, or
        financial advice, and we take no money from facilities.
      </footer>
    </>
  );
}
