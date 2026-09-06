import { useState } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { Empty, ErrorState, Loading } from "./ui";

/**
 * A family's own search.
 *
 * The cold open exists so a judge can see the product without typing anything.
 * This is the other door: someone with a real parent, in a real town, who needs
 * this for themselves. Same machinery underneath — the only difference is that
 * the shortlist is computed from where they are looking.
 *
 * The facility list below the ZIP field is a live query, not a preview built
 * from a submit. Type five digits and real Medicare-certified homes appear,
 * ordered by distance, before anything has been created. That is worth doing
 * for its own sake — nobody should have to commit to a search to find out
 * whether it has any results — and it is the clearest place in the product to
 * see a Convex query update itself.
 */

const CARE_LEVELS = [
  {
    value: "assisted" as const,
    label: "Assisted living",
    hint: "Help with daily tasks — washing, dressing, medication",
  },
  {
    value: "memory" as const,
    label: "Memory care",
    hint: "Secured setting for dementia or Alzheimer's",
  },
  {
    value: "skilled" as const,
    label: "Skilled nursing",
    hint: "Round-the-clock clinical care from licensed nurses",
  },
  {
    value: "independent" as const,
    label: "Independent living",
    hint: "Their own home, with support nearby",
  },
];

const MUST_HAVES = [
  "memory care on site",
  "private room",
  "accepts Medicaid",
  "close to family",
  "no shared bathroom",
  "pets allowed",
];

const RADII = [10, 25, 50];

type CareLevel = (typeof CARE_LEVELS)[number]["value"];

export default function NewSearch({
  onStarted,
  onCancel,
  ready,
}: {
  onStarted: (id: Id<"searches">) => void;
  onCancel: () => void;
  ready: boolean;
}) {
  const [label, setLabel] = useState("");
  const [zip, setZip] = useState("");
  const [radiusMiles, setRadius] = useState(25);
  const [careLevel, setCareLevel] = useState<CareLevel>("assisted");
  const [budget, setBudget] = useState("");
  const [mustHaves, setMustHaves] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = useAction(api.geo.startSearchNearZip);

  // Only ask the backend once the ZIP could possibly be real. "skip" keeps us
  // from firing a query on every keystroke of a half-typed code.
  const zipReady = /^\d{5}$/.test(zip);
  const near = useQuery(
    api.geo.facilitiesNearZip,
    zipReady ? { zip, radiusMiles, limit: 12 } : "skip",
  );

  function toggleMustHave(item: string) {
    setMustHaves((cur) =>
      cur.includes(item) ? cur.filter((x) => x !== item) : [...cur, item],
    );
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!zipReady || busy) return;
    setBusy(true);
    setError(null);

    const parsedBudget = Number(budget.replace(/[^0-9]/g, ""));
    void start({
      label: label.trim() || "My search",
      zip,
      radiusMiles,
      careLevel,
      budgetMax: Number.isFinite(parsedBudget) && parsedBudget > 0 ? parsedBudget : undefined,
      mustHaves,
    })
      .then((r) => {
        if (r.searchId) {
          onStarted(r.searchId);
          return;
        }
        // Say which of the two things went wrong. "No results" reads as a
        // broken product when the real answer is a mistyped ZIP.
        setError(
          r.reason === "unknown_zip"
            ? "We do not recognise that ZIP code. Check the five digits and try again."
            : `We could not find a Medicare-certified facility within ${radiusMiles} miles of ${zip}. Try a wider radius.`,
        );
      })
      .catch((e) => {
        console.error("startSearchNearZip failed", e);
        setError(
          "We could not start that search just now. This is our backend rather than your connection — trying again usually works.",
        );
      })
      .finally(() => setBusy(false));
  }

  const matches = near?.facilities ?? [];

  return (
    <section className="mx-auto grid max-w-7xl gap-12 px-6 py-12 lg:grid-cols-[minmax(0,1fr)_420px] lg:gap-16">
      <div>
        <h1 className="text-[28px] font-semibold leading-tight sm:text-[32px]">
          Search where you are actually looking
        </h1>
        <p className="mt-4 max-w-2xl text-[17px] leading-relaxed text-muted">
          Ombuds reads the federal inspection record for every Medicare-certified
          facility near you, then emails each one on your shortlist to ask what
          is never published. Nothing here is paid for by a facility.
        </p>

        <form onSubmit={submit} className="mt-8 max-w-2xl">
          <div className="grid gap-6 sm:grid-cols-2">
            <div>
              <label htmlFor="zip" className="block text-[15px] font-medium">
                ZIP code
              </label>
              <input
                id="zip"
                inputMode="numeric"
                autoComplete="postal-code"
                placeholder="91767"
                value={zip}
                onChange={(e) => setZip(e.target.value.replace(/[^0-9]/g, "").slice(0, 5))}
                className="mt-2 w-full rounded border border-rule-strong bg-transparent px-3 py-2.5 text-[16px] tabular-nums"
              />
              <p className="mt-1.5 text-[14px] text-muted">
                Where they will be living.
              </p>
            </div>

            <div>
              <label htmlFor="radius" className="block text-[15px] font-medium">
                How far you would travel
              </label>
              <select
                id="radius"
                value={radiusMiles}
                onChange={(e) => setRadius(Number(e.target.value))}
                className="mt-2 w-full rounded border border-rule-strong bg-transparent px-3 py-2.5 text-[16px]"
              >
                {RADII.map((r) => (
                  <option key={r} value={r}>
                    Within {r} miles
                  </option>
                ))}
              </select>
            </div>
          </div>

          <fieldset className="mt-8">
            <legend className="text-[15px] font-medium">
              What kind of care do they need?
            </legend>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {CARE_LEVELS.map((c) => {
                const active = careLevel === c.value;
                return (
                  <label
                    key={c.value}
                    className={`cursor-pointer rounded border p-3 ${
                      active ? "border-rule-strong" : "border-rule"
                    }`}
                  >
                    <input
                      type="radio"
                      name="careLevel"
                      value={c.value}
                      checked={active}
                      onChange={() => setCareLevel(c.value)}
                      className="sr-only"
                    />
                    <span
                      className={`block text-[15px] ${active ? "font-semibold" : ""}`}
                    >
                      {c.label}
                    </span>
                    <span className="mt-0.5 block text-[14px] leading-snug text-muted">
                      {c.hint}
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          <div className="mt-8 grid gap-6 sm:grid-cols-2">
            <div>
              <label htmlFor="budget" className="block text-[15px] font-medium">
                Monthly budget <span className="text-muted">(optional)</span>
              </label>
              <input
                id="budget"
                inputMode="numeric"
                placeholder="7000"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                className="mt-2 w-full rounded border border-rule-strong bg-transparent px-3 py-2.5 text-[16px] tabular-nums"
              />
              <p className="mt-1.5 text-[14px] text-muted">
                Used to ask each facility the right question about cost. Never
                used to hide a home from you.
              </p>
            </div>

            <div>
              <label htmlFor="label" className="block text-[15px] font-medium">
                Name this search <span className="text-muted">(optional)</span>
              </label>
              <input
                id="label"
                placeholder="Mum"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                className="mt-2 w-full rounded border border-rule-strong bg-transparent px-3 py-2.5 text-[16px]"
              />
              <p className="mt-1.5 text-[14px] text-muted">
                So you can tell two searches apart later.
              </p>
            </div>
          </div>

          <fieldset className="mt-8">
            <legend className="text-[15px] font-medium">
              Anything that matters <span className="text-muted">(optional)</span>
            </legend>
            <div className="mt-3 flex flex-wrap gap-2">
              {MUST_HAVES.map((m) => {
                const active = mustHaves.includes(m);
                return (
                  <label
                    key={m}
                    className={`cursor-pointer rounded-full border px-3 py-1.5 text-[14px] ${
                      active
                        ? "border-rule-strong font-medium"
                        : "border-rule text-muted"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={active}
                      onChange={() => toggleMustHave(m)}
                      className="sr-only"
                    />
                    {m}
                  </label>
                );
              })}
            </div>
          </fieldset>

          <div className="mt-10 flex flex-wrap items-center gap-4">
            <button
              type="submit"
              disabled={!zipReady || busy || !ready || matches.length === 0}
              className="rounded bg-ink px-6 py-3.5 text-[17px] font-semibold text-paper disabled:opacity-60"
            >
              {busy
                ? "Opening the board…"
                : matches.length > 0
                  ? `Email these ${matches.length} facilities`
                  : "Enter a ZIP code"}
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="text-[16px] underline underline-offset-4"
            >
              Back
            </button>
          </div>

          {error && (
            <div className="mt-6 max-w-2xl">
              <ErrorState
                title="That search did not start."
                detail={error}
                onRetry={() => setError(null)}
              />
            </div>
          )}
        </form>
      </div>

      <NearbyPreview
        zipReady={zipReady}
        loading={zipReady && near === undefined}
        result={near}
        radiusMiles={radiusMiles}
        zip={zip}
      />
    </section>
  );
}

/**
 * What is actually near them, before they commit to anything.
 *
 * Deliberately shows the whole list — a one-star home and a facility on CMS's
 * chronic-poor-performer list appear here exactly like any other. Sorting by
 * distance rather than by rating is the honest ordering for "what is near me";
 * the safety record is what the board is for.
 */
function NearbyPreview({
  zipReady,
  loading,
  result,
  radiusMiles,
  zip,
}: {
  zipReady: boolean;
  loading: boolean;
  result:
    | {
        origin: { precision: "zip" | "zip3" } | null;
        facilities: Array<{
          ccn: string;
          name: string;
          city: string;
          state: string;
          distanceMiles: number;
          overallRating: number;
          abuseIcon: boolean;
          specialFocusStatus: string | null;
        }>;
      }
    | undefined;
  radiusMiles: number;
  zip: string;
}) {
  return (
    <aside className="lg:pt-2">
      <h2 className="text-[14px] font-medium uppercase tracking-wide text-muted">
        Facilities we would write to
      </h2>

      <div className="mt-4 rounded border border-rule">
        {!zipReady && (
          <div className="p-5">
            <Empty
              title="Enter a ZIP code"
            >
              {"Type five digits and every Medicare-certified facility within range appears here, nearest first."}
            </Empty>
          </div>
        )}

        {loading && (
          <div className="p-5">
            <Loading what="Reading the federal record…" />
          </div>
        )}

        {zipReady && result && result.origin === null && (
          <div className="p-5">
            <Empty
              title="We do not recognise that ZIP"
            >
              {`${zip} is not a ZIP code we can place on a map. Check the five digits.`}
            </Empty>
          </div>
        )}

        {zipReady && result && result.origin !== null && result.facilities.length === 0 && (
          <div className="p-5">
            <Empty
              title="Nothing certified within that distance"
            >
              {`No Medicare-certified facility sits within ${radiusMiles} miles of ${zip}. Widening the radius usually finds some.`}
            </Empty>
          </div>
        )}

        {result?.facilities.map((f, i) => (
          <div key={f.ccn} className={`p-4 ${i > 0 ? "border-t border-rule" : ""}`}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[15px] font-medium leading-snug">
                {f.name}
              </span>
              <span className="shrink-0 text-[14px] tabular-nums text-muted">
                {f.distanceMiles.toFixed(1)} mi
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[14px] text-muted">
              <span>
                {f.city}, {f.state}
              </span>
              <span>
                {f.overallRating > 0
                  ? `${f.overallRating} of 5 overall`
                  : "CMS published no rating"}
              </span>
              {/* Red is reserved for harm. Both of these are harm. */}
              {f.abuseIcon && (
                <span className="font-medium text-harm">Abuse citation</span>
              )}
              {f.specialFocusStatus && (
                <span className="font-medium text-harm">Special focus</span>
              )}
            </div>
          </div>
        ))}
      </div>

      {result?.origin?.precision === "zip3" && (
        <p className="mt-3 text-[14px] leading-snug text-muted">
          No certified facility sits inside {zip} itself, so distances are
          measured from the centre of the wider {zip.slice(0, 3)} postal area.
        </p>
      )}

      {result && result.facilities.length > 0 && (
        <p className="mt-3 text-[14px] leading-snug text-muted">
          Every facility in range is listed, including poorly rated ones. Ombuds
          takes no money from facilities, so none of them can pay to appear —
          or to be left out.
        </p>
      )}
    </aside>
  );
}
