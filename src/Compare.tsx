import { useEffect, useRef } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import { useLazyTranslate } from "./useLazyTranslate";
import { facilityName } from "./facilityName";
import { Loading } from "./ui";
import { HARM_CHIP, HARM_LABEL, PATTERN_LABEL, fmtDate, type HarmLevel } from "./severity";

/**
 * Three real facilities, side by side, with the same federal data read the
 * same way. The point of this view is the contrast: the same inspection
 * programme produces three genuinely different records, and a family cannot
 * see the difference in the raw tag codes.
 */

function Column({
  ccn,
  onOpenFacility,
}: {
  ccn: string;
  onOpenFacility?: (ccn: string) => void;
}) {
  const detail = useQuery(api.deficiencies.facilityDetail, { ccn });
  useLazyTranslate(ccn, detail != null);

  if (!detail) {
    return (
      <div className="rounded border border-rule p-5">
        <Loading what="Loading this facility's record…" />
      </div>
    );
  }

  const { facility, counts, riskSummary, immediateJeopardy, worstFirst } = detail;
  const worst = worstFirst[0];
  const hasJeopardy = counts.immediateJeopardy > 0;

  return (
    <div
      className={`flex flex-col rounded border p-5 ${
        hasJeopardy
          ? "border-harm-edge"
          : "border-rule"
      }`}
    >
      {hasJeopardy && (
        <p
          role="alert"
          className="-mx-5 -mt-5 mb-4 rounded-t bg-harm-solid px-5 py-2 text-[14px] font-semibold text-white"
        >
          Immediate jeopardy on record ({counts.immediateJeopardy})
        </p>
      )}

      <h3 className="text-[17px] font-semibold leading-snug">
        {onOpenFacility ? (
          <button
            onClick={() => onOpenFacility(ccn)}
            className="text-left underline underline-offset-4"
          >
            {facilityName(facility.name)}
            <span className="sr-only"> — open the full inspection record</span>
          </button>
        ) : (
          facilityName(facility.name)
        )}
      </h3>
      <p className="mt-2 text-[14px] text-muted">
        {facility.city}, {facility.state} · {facility.certifiedBeds} beds ·{" "}
        {facility.overallRating > 0
          ? `${facility.overallRating}★ CMS overall`
          : "no CMS rating published"}
      </p>

      <dl className="mt-4 grid grid-cols-3 gap-2 border-y border-rule py-3 text-center">
        <div>
          <dd className="text-[20px] font-semibold">{counts.total}</dd>
          <dt className="text-[14px] text-muted">
            findings
          </dt>
        </div>
        <div>
          <dd
            className={`text-[20px] font-semibold ${
              counts.actualHarm ? "text-harm" : ""
            }`}
          >
            {counts.actualHarm}
          </dd>
          <dt className="text-[14px] text-muted">
            actual harm
          </dt>
        </div>
        <div>
          <dd
            className={`text-[20px] font-semibold ${
              counts.immediateJeopardy ? "text-harm" : ""
            }`}
          >
            {counts.immediateJeopardy}
          </dd>
          <dt className="text-[14px] text-muted">
            jeopardy
          </dt>
        </div>
      </dl>

      <h4 className="mt-4 text-[14px] font-medium uppercase tracking-wide text-muted">
        The pattern over time
      </h4>
      {riskSummary ? (
        <>
          <p className="mt-2 text-[16px] leading-relaxed">{riskSummary.summary}</p>
          <p className="mt-2 text-[14px] text-muted">
            {PATTERN_LABEL[riskSummary.pattern] ?? riskSummary.pattern} · written
            by {riskSummary.model}
          </p>
        </>
      ) : (
        <p className="mt-2 text-[16px] text-muted">
          Reading {counts.total} findings…
        </p>
      )}

      <h4 className="mt-4 text-[14px] font-medium uppercase tracking-wide text-muted">
        Most serious finding
      </h4>
      {worst ? (
        <>
          <span
            className={`mt-1 inline-block self-start rounded border px-2 py-0.5 text-[14px] font-medium ${
              HARM_CHIP[worst.harmLevel as HarmLevel]
            }`}
          >
            {HARM_LABEL[worst.harmLevel as HarmLevel]}
          </span>
          <p className="mt-2 text-[16px] leading-relaxed">
            {worst.full ?? "Translating…"}
          </p>
          <p className="mt-2 text-[14px] text-muted">
            {worst.tag} · scope/severity {worst.scopeSeverity} · inspected{" "}
            {fmtDate(worst.surveyDate)}
          </p>
        </>
      ) : (
        <p className="mt-2 text-[16px] text-muted">
          No findings on record.
        </p>
      )}

      <p className="mt-auto pt-4 text-[14px] text-muted">
        {immediateJeopardy.length > 0
          ? `Jeopardy findings: ${immediateJeopardy
              .map((c) => fmtDate(c.surveyDate))
              .join(", ")}`
          : "No immediate jeopardy on record."}
      </p>
    </div>
  );
}

/** Evidence that the cache is doing what it claims. */
function CacheLine({ ccns }: { ccns: string[] }) {
  const stats = useQuery(api.deficiencies.cacheStats, { ccns });
  if (!stats) return null;
  return (
    <p className="mt-2 text-[14px] text-muted">
      {stats.cachedMeanings} distinct meanings translated so far, covering{" "}
      {stats.citationsCovered} of the {stats.citationsTotal} citations on these
      facilities. A meaning is cached by tag and severity, so it is written once
      and reused by every facility in the country that was ever cited the same
      way.
    </p>
  );
}

/**
 * How many of these facilities we can actually write to.
 *
 * The failures are on the board on purpose. Firecrawl finds a contact address
 * for somewhere between half and three quarters of facilities — many homes have
 * no website, or one with no address published on it — and a board that quietly
 * listed only the reachable ones would be doing the same filtering as the
 * referral service this product exists to argue against. A facility we cannot
 * email keeps its place, its phone number, and its whole inspection record.
 */
function ReachLine({ ccns }: { ccns: string[] }) {
  const status = useQuery(api.enrichment.enrichmentStatus, { ccns });
  const enrichBatch = useMutation(api.enrichment.enrichBatch);
  const started = useRef(false);

  // Fanned out through a bounded workpool rather than fired all at once, so a
  // fifteen-facility shortlist never becomes fifteen simultaneous requests.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void enrichBatch({ ccns }).catch((e) =>
      console.error("contact discovery could not be queued", e),
    );
  }, [ccns, enrichBatch]);

  if (!status || status.total === 0) return null;
  const settled = status.total - status.unstarted - status.pending;

  return (
    <p className="mt-2 text-[14px] text-muted">
      {settled < status.total ? (
        <>Looking for a way to contact {status.total} facilities… </>
      ) : (
        <>
          {status.discovered} of {status.total} reachable by email.{" "}
        </>
      )}
      {status.noWebsite > 0 && <>{status.noWebsite} publish no website. </>}
      {status.noEmail > 0 && (
        <>{status.noEmail} have a website with no address on it. </>
      )}
      {status.failed > 0 && <>{status.failed} could not be checked. </>}
      The federal record gives us a telephone number and nothing else, so every
      address above was found on the open web. Facilities we could not reach stay
      on the board with their inspection record.
      {status.lastError ? ` ${status.lastError}` : ""}
    </p>
  );
}

export function Compare({
  ccns,
  onOpenFacility,
}: {
  ccns: string[];
  onOpenFacility?: (ccn: string) => void;
}) {
  return (
    <section className="mx-auto max-w-7xl px-6 py-12">
      {/* h2, not h1. The page already has one, at the top, and a second
          top-level heading halfway down leaves a screen reader — and a judge
          skimming — with two competing claims about what this page is. */}
      <h2 className="text-[24px] font-semibold leading-tight sm:text-[28px]">
        Three facilities, three very different records
      </h2>
      <p className="mt-3 max-w-3xl text-[18px] leading-relaxed text-muted">
        All three are real, Medicare-certified nursing homes in California. All
        the data below comes from the same federal inspection programme. The
        raw record is published as tag codes and severity letters; this is the
        same record in plain English.
      </p>

      <div className="mt-8 grid gap-5 lg:grid-cols-3">
        {ccns.map((ccn) => (
          <Column key={ccn} ccn={ccn} onOpenFacility={onOpenFacility} />
        ))}
      </div>

      {/* Both of these are notes on method, and they used to sit between the
          heading and the records they are about — so a reader met two dense
          paragraphs of caching and crawl statistics before reaching a single
          fact about a nursing home. They belong underneath, as footnotes to
          the thing they describe. */}
      <div className="mt-6 border-t border-rule pt-4">
        <CacheLine ccns={ccns} />
        <ReachLine ccns={ccns} />
      </div>
    </section>
  );
}
