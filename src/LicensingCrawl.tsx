import { useState } from "react";
import { useAction, usePaginatedQuery, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import { Provenance } from "./FacilityDetail";
import { fmtDate } from "./severity";

/**
 * A live crawl of a state assisted-living licensing portal.
 *
 * The point this section makes: CMS certifies nursing homes. Assisted living,
 * adult homes, and enriched housing are licensed by the STATES and appear
 * nowhere in the federal data — so for a family whose parent does not need
 * skilled nursing, the entire inspection record is silent. This is where the
 * product goes past what the federal government knows.
 *
 * The progress below is not polled. Firecrawl advances a row inside Convex as
 * pages land, and this component subscribes to it with an ordinary `useQuery`;
 * the numbers move on their own.
 */

const STATE: "NY" = "NY";

function ProgressBar({
  completed,
  total,
}: {
  completed: number;
  total: number;
}) {
  const pct = total > 0 ? Math.min(100, (completed / total) * 100) : 0;
  return (
    <div
      role="progressbar"
      aria-valuenow={completed}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-label="Pages crawled"
      className="mt-3 h-2 w-full overflow-hidden rounded bg-[#f4f5f7] dark:bg-[#1b1f22]"
    >
      <div
        className="h-full bg-[#14171a] transition-[width] duration-500 dark:bg-[#e8ebee]"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function CrawlMonitor({ crawlId }: { crawlId: string }) {
  const progress = useQuery(api.licensing.crawlProgress, { crawlId });
  const { results: pages } = usePaginatedQuery(
    api.licensing.crawlPages,
    { crawlId },
    { initialNumItems: 8 },
  );

  if (progress === undefined) {
    return <p className="mt-3 text-[#5b6570] dark:text-[#9aa4ad]">Starting…</p>;
  }
  if (progress === null) return null;

  const running = progress.status === "scraping";

  return (
    <div className="mt-4">
      <p className="text-[15px]">
        <span className="font-medium">{progress.portalName}</span>{" "}
        <span className="text-[#5b6570] dark:text-[#9aa4ad]">
          · {progress.status}
          {running ? " — reading pages now" : ""}
        </span>
      </p>

      <ProgressBar
        completed={progress.completed ?? progress.pageCount}
        total={progress.total ?? Math.max(1, progress.pageCount)}
      />

      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        <div>
          <dt className="text-[13px] text-[#5b6570] dark:text-[#9aa4ad]">
            Pages read
          </dt>
          <dd className="text-[17px] font-medium tabular-nums">
            {progress.completed ?? progress.pageCount}
            {progress.total !== null ? ` of ${progress.total}` : ""}
          </dd>
        </div>
        <div>
          <dt className="text-[13px] text-[#5b6570] dark:text-[#9aa4ad]">
            Stored in Convex
          </dt>
          <dd className="text-[17px] font-medium tabular-nums">
            {progress.pageCount}
          </dd>
        </div>
        <div>
          <dt className="text-[13px] text-[#5b6570] dark:text-[#9aa4ad]">
            Facilities found
          </dt>
          <dd className="text-[17px] font-medium tabular-nums">
            {progress.facilitiesExtracted}
          </dd>
        </div>
        <div>
          <dt className="text-[13px] text-[#5b6570] dark:text-[#9aa4ad]">
            Firecrawl credits
          </dt>
          <dd className="text-[17px] font-medium tabular-nums">
            {progress.creditsUsed ?? 0}
          </dd>
        </div>
      </dl>

      {progress.error && (
        <p className="mt-3 max-w-3xl text-[15px]">{progress.error}</p>
      )}

      {pages.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-[14px] text-[#5b6570] underline underline-offset-2 dark:text-[#9aa4ad]">
            Pages this crawl has read
          </summary>
          <ul className="mt-2 space-y-1">
            {pages.map((page) => (
              <li
                key={page._id}
                className="break-all text-[13px] text-[#5b6570] dark:text-[#9aa4ad]"
              >
                {page.url}
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* Most pages on a licensing portal are navigation. Saying so is more
          honest than reporting only the one page that carried the register. */}
      {!running && progress.pagesWithNoRows > 0 && (
        <Provenance>
          {progress.pagesWithNoRows} of the {progress.pageCount} pages crawled
          were navigation and carried no facility records. Delivery mode:{" "}
          {progress.mode}.
        </Provenance>
      )}
    </div>
  );
}

export function LicensingCrawl() {
  const coverage = useQuery(api.licensing.stateCoverage, { state: STATE });
  const latest = useQuery(api.licensing.latestCrawl, { state: STATE });
  const start = useAction(api.licensing.startStateCrawl);

  const [crawlId, setCrawlId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeCrawlId = crawlId ?? latest?.crawlId ?? null;

  async function run() {
    setStarting(true);
    setError(null);
    try {
      const result = await start({ state: STATE });
      if (result.ok && result.crawlId) setCrawlId(result.crawlId);
      else setError(result.error);
    } catch (e) {
      console.error("crawl failed to start", e);
      setError(
        "We could not start the crawl just now. Nothing else on this page is " +
          "affected.",
      );
    } finally {
      setStarting(false);
    }
  }

  return (
    <section className="mx-auto max-w-4xl px-6 py-10">
      <h2 className="text-2xl font-semibold">
        What the federal record does not cover
      </h2>
      <p className="mt-2 max-w-3xl text-[16px] leading-relaxed">
        Everything above comes from the federal inspection record, which covers
        Medicare-certified <em>nursing homes</em>. Assisted living, adult homes,
        and enriched housing are licensed by the states, and the federal
        government does not inspect them or publish anything about them at all.
        {coverage
          ? ` ${coverage.description}`
          : ""}
      </p>

      {coverage && coverage.licensedCount > 0 && (
        <p className="mt-4 text-[17px]">
          <span className="text-3xl font-semibold tabular-nums">
            {coverage.licensedCount}
          </span>{" "}
          facilities {coverage.state} licenses that have no federal inspection
          record.
        </p>
      )}

      <button
        onClick={() => void run()}
        disabled={starting}
        className="mt-4 rounded border border-[#d8dce1] px-4 py-2 text-[15px] font-medium underline underline-offset-4 disabled:opacity-50 dark:border-[#2b3236]"
      >
        {starting ? "Starting the crawl…" : "Crawl the state register now"}
      </button>

      {error && <p className="mt-3 max-w-3xl text-[15px]">{error}</p>}

      {activeCrawlId && <CrawlMonitor crawlId={activeCrawlId} />}

      {coverage && coverage.sample.length > 0 && (
        <div className="mt-6">
          <h3 className="text-[15px] font-medium">
            A few of the facilities this crawl found
          </h3>
          <ul className="mt-2">
            {coverage.sample.map((facility) => (
              <li
                key={`${facility.name}-${facility.zip}`}
                className="border-t border-[#d8dce1] py-3 dark:border-[#2b3236]"
              >
                <p className="text-[16px] font-medium">{facility.name}</p>
                <p className="text-[15px] text-[#5b6570] dark:text-[#9aa4ad]">
                  {facility.address}, {facility.city} {facility.zip} ·{" "}
                  {facility.phone} · {facility.careTypes.join(", ")}
                </p>
              </li>
            ))}
          </ul>
          <Provenance>
            Read from{" "}
            <a
              href={coverage.registerUrl ?? coverage.url}
              target="_blank"
              rel="noreferrer noopener"
              className="underline underline-offset-2 break-all"
            >
              {coverage.registerUrl ?? coverage.url}
            </a>
            {coverage.crawledAt ? ` on ${fmtDate(coverage.crawledAt)}` : ""},
            the state's own published register. These facilities have no
            Medicare certification number, so there is no federal inspection
            history to show for them — which is exactly the point.
          </Provenance>
        </div>
      )}
    </section>
  );
}
