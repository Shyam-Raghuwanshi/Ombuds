import { useState } from "react";
import { facilityName } from "./facilityName";
import { useAction, usePaginatedQuery, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";

import { fmtDate } from "./severity";
import { ErrorState, Loading, Provenance } from "./ui";

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
      className="mt-3 h-2 w-full overflow-hidden rounded bg-sunk"
    >
      <div
        className="h-full bg-ink transition-[width] duration-500"
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
    return (
      <div className="mt-3">
        <Loading what="Starting the crawl…" />
      </div>
    );
  }
  if (progress === null) return null;

  const running = progress.status === "scraping";

  return (
    <div className="mt-4">
      <p className="t-body">
        <span className="font-bold">{progress.portalName}</span>{" "}
        <span className="text-muted">
          · {progress.status}
          {running ? " — reading pages now" : ""}
        </span>
      </p>

      <ProgressBar
        completed={progress.completed ?? progress.pageCount}
        total={progress.total ?? Math.max(1, progress.pageCount)}
      />

      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
        <div>
          <dt className="t-label">Pages read</dt>
          <dd className="t-figure mt-1.5">
            {progress.completed ?? progress.pageCount}
            {progress.total !== null ? ` of ${progress.total}` : ""}
          </dd>
        </div>
        <div>
          <dt className="t-label">Stored in Convex</dt>
          <dd className="t-figure mt-1.5">
            {progress.pageCount}
          </dd>
        </div>
        <div>
          <dt className="t-label">Facilities found</dt>
          <dd className="t-figure mt-1.5">
            {progress.facilitiesExtracted}
          </dd>
        </div>
        <div>
          <dt className="t-label">Firecrawl credits</dt>
          <dd className="t-figure mt-1.5">
            {progress.creditsUsed ?? 0}
          </dd>
        </div>
      </dl>

      {progress.error && (
        <div className="mt-3 max-w-3xl">
          <ErrorState title="The crawl stopped early." detail={progress.error} />
        </div>
      )}

      {pages.length > 0 && (
        <details className="mt-4">
          <summary className="t-body link cursor-pointer text-muted">
            Pages this crawl has read
          </summary>
          <ul className="mt-2 space-y-1">
            {pages.map((page) => (
              <li key={page._id} className="t-meta t-code break-all">
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
    <section className="mx-auto max-w-7xl px-6 py-10">
      <h2 className="t-title">What the federal record does not cover</h2>
      <p className="t-lede measure mt-3">
        Everything above comes from the federal inspection record, which covers
        Medicare-certified <em>nursing homes</em>. Assisted living, adult homes,
        and enriched housing are licensed by the states, and the federal
        government does not inspect them or publish anything about them at all.
        {coverage
          ? ` ${coverage.description}`
          : ""}
      </p>

      {coverage && coverage.licensedCount > 0 && (
        <p className="t-body measure mt-5">
          <span className="t-figure align-baseline">
            {coverage.licensedCount}
          </span>{" "}
          facilities {coverage.state} licenses that have no federal inspection
          record.
        </p>
      )}

      <button
        onClick={() => void run()}
        disabled={starting}
        className="btn btn-quiet mt-5"
      >
        {starting ? "Starting the crawl…" : "Crawl the state register now"}
      </button>

      {error && (
        <div className="mt-3 max-w-3xl">
          <ErrorState
            title="We could not start the crawl."
            detail={error}
            onRetry={() => void run()}
          />
        </div>
      )}

      {activeCrawlId && <CrawlMonitor crawlId={activeCrawlId} />}

      {coverage && coverage.sample.length > 0 && (
        <div className="mt-6">
          <h3 className="t-name">A few of the facilities this crawl found</h3>
          <ul className="mt-2">
            {coverage.sample.map((facility) => (
              <li
                key={`${facility.name}-${facility.zip}`}
                className="border-t border-rule py-3"
              >
                <p className="t-name">{facilityName(facility.name)}</p>
                <p className="t-meta mt-1">
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
              className="link break-all"
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
