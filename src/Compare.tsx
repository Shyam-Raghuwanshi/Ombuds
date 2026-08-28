import { useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import { useLazyTranslate } from "./useLazyTranslate";
import { HARM_CHIP, HARM_LABEL, PATTERN_LABEL, fmtDate, type HarmLevel } from "./severity";

/**
 * Three real facilities, side by side, with the same federal data read the
 * same way. The point of this view is the contrast: the same inspection
 * programme produces three genuinely different records, and a family cannot
 * see the difference in the raw tag codes.
 */

function Column({ ccn }: { ccn: string }) {
  const detail = useQuery(api.deficiencies.facilityDetail, { ccn });
  useLazyTranslate(ccn, detail != null);

  if (!detail) {
    return (
      <div className="rounded border border-[#d8dce1] p-5 dark:border-[#2b3236]">
        <p className="text-[#5b6570]">Loading…</p>
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
          ? "border-[#b3241c] dark:border-[#7a1410]"
          : "border-[#d8dce1] dark:border-[#2b3236]"
      }`}
    >
      {hasJeopardy && (
        <p
          role="alert"
          className="-mx-5 -mt-5 mb-4 rounded-t bg-[#b3241c] px-5 py-2 text-[14px] font-semibold text-white"
        >
          Immediate jeopardy on record ({counts.immediateJeopardy})
        </p>
      )}

      <h3 className="text-[17px] font-semibold leading-snug">{facility.name}</h3>
      <p className="mt-1 text-[14px] text-[#5b6570] dark:text-[#9aa4ad]">
        {facility.city}, {facility.state} · {facility.certifiedBeds} beds ·{" "}
        {facility.overallRating > 0
          ? `${facility.overallRating}★ CMS overall`
          : "no CMS rating published"}
      </p>

      <dl className="mt-4 grid grid-cols-3 gap-2 border-y border-[#d8dce1] py-3 text-center dark:border-[#2b3236]">
        <div>
          <dd className="text-[20px] font-semibold">{counts.total}</dd>
          <dt className="text-[12px] text-[#5b6570] dark:text-[#9aa4ad]">
            findings
          </dt>
        </div>
        <div>
          <dd
            className={`text-[20px] font-semibold ${
              counts.actualHarm ? "text-[#b3241c] dark:text-[#ff8a80]" : ""
            }`}
          >
            {counts.actualHarm}
          </dd>
          <dt className="text-[12px] text-[#5b6570] dark:text-[#9aa4ad]">
            actual harm
          </dt>
        </div>
        <div>
          <dd
            className={`text-[20px] font-semibold ${
              counts.immediateJeopardy ? "text-[#b3241c] dark:text-[#ff8a80]" : ""
            }`}
          >
            {counts.immediateJeopardy}
          </dd>
          <dt className="text-[12px] text-[#5b6570] dark:text-[#9aa4ad]">
            jeopardy
          </dt>
        </div>
      </dl>

      <h4 className="mt-4 text-[13px] font-medium uppercase tracking-wide text-[#5b6570] dark:text-[#9aa4ad]">
        The pattern over time
      </h4>
      {riskSummary ? (
        <>
          <p className="mt-1 text-[15px] leading-relaxed">{riskSummary.summary}</p>
          <p className="mt-1 text-[12px] text-[#5b6570] dark:text-[#9aa4ad]">
            {PATTERN_LABEL[riskSummary.pattern] ?? riskSummary.pattern} · written
            by {riskSummary.model}
          </p>
        </>
      ) : (
        <p className="mt-1 text-[15px] text-[#5b6570] dark:text-[#9aa4ad]">
          Reading {counts.total} findings…
        </p>
      )}

      <h4 className="mt-4 text-[13px] font-medium uppercase tracking-wide text-[#5b6570] dark:text-[#9aa4ad]">
        Most serious finding
      </h4>
      {worst ? (
        <>
          <span
            className={`mt-1 inline-block self-start rounded border px-2 py-0.5 text-[13px] font-medium ${
              HARM_CHIP[worst.harmLevel as HarmLevel]
            }`}
          >
            {HARM_LABEL[worst.harmLevel as HarmLevel]}
          </span>
          <p className="mt-2 text-[15px] leading-relaxed">
            {worst.full ?? "Translating…"}
          </p>
          <p className="mt-1 text-[12px] text-[#5b6570] dark:text-[#9aa4ad]">
            {worst.tag} · scope/severity {worst.scopeSeverity} · inspected{" "}
            {fmtDate(worst.surveyDate)}
          </p>
        </>
      ) : (
        <p className="mt-1 text-[15px] text-[#5b6570] dark:text-[#9aa4ad]">
          No findings on record.
        </p>
      )}

      <p className="mt-auto pt-4 text-[12px] text-[#5b6570] dark:text-[#9aa4ad]">
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
function CacheLine() {
  const stats = useQuery(api.deficiencies.cacheStats, {});
  if (!stats) return null;
  return (
    <p className="mt-2 text-[14px] text-[#5b6570] dark:text-[#9aa4ad]">
      {stats.cachedMeanings} distinct meanings translated so far, covering{" "}
      {stats.citationsCovered} citations on file. A meaning is cached by tag and
      severity, so it is written once and reused by every facility in the
      country that was ever cited the same way.
    </p>
  );
}

export function Compare({ ccns }: { ccns: string[] }) {
  return (
    <section className="mx-auto max-w-7xl px-6 py-10">
      <h1 className="text-3xl font-semibold leading-tight">
        Three facilities, three very different records
      </h1>
      <p className="mt-3 max-w-3xl text-[17px] leading-relaxed text-[#5b6570] dark:text-[#9aa4ad]">
        All three are real, Medicare-certified nursing homes in California. All
        the data below comes from the same federal inspection programme. The
        raw record is published as tag codes and severity letters; this is the
        same record in plain English.
      </p>
      <CacheLine />
      <div className="mt-8 grid gap-5 lg:grid-cols-3">
        {ccns.map((ccn) => (
          <Column key={ccn} ccn={ccn} />
        ))}
      </div>
    </section>
  );
}
