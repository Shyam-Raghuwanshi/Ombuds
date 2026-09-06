import { useQuery } from "convex/react";
import { facilityName } from "./facilityName";
import { api } from "../convex/_generated/api";
import { ContactPanel } from "./ContactPanel";
import { Empty, Loading, Provenance } from "./ui";
import { NewsPanel } from "./NewsPanel";
import { useDiscovery } from "./useDiscovery";
import { useLazyTranslate } from "./useLazyTranslate";
import {
  HARM_CHIP,
  HARM_LABEL,
  PATTERN_LABEL,
  SPREAD_LABEL,
  fmtDate,
  type HarmLevel,
} from "./severity";

/**
 * The facility detail page.
 *
 * Two rules from CLAUDE.md this file exists to honour:
 *  - Immediate jeopardy gets a red banner. Nothing else in the product is red.
 *  - Every federal figure carries its survey date, and every model-written
 *    sentence says a model wrote it. We never blur the line between the
 *    federal record and something we generated from it.
 */

type Citation = {
  _id: string;
  tag: string;
  tagDescription: string;
  scopeSeverity: string;
  harmLevel: string;
  spread: string;
  surveyDate: number;
  correctionDate?: number;
  isComplaint: boolean;
  plainEnglish: string | null;
  full: string | null;
};

/**
 * The only red banner in the product. Rendered when, and only when, the
 * federal record contains a citation at severity J, K, or L — a finding that
 * residents were in immediate danger of serious injury or death.
 */
function ImmediateJeopardyBanner({ citations }: { citations: Citation[] }) {
  if (citations.length === 0) return null;
  const years = [
    ...new Set(
      citations.map((c) => new Date(c.surveyDate).getUTCFullYear()),
    ),
  ].sort();
  return (
    <section
      role="alert"
      className="surface-harm mb-8 rounded-lg border-l-4 border-harm-edge bg-harm-solid px-5 py-4 text-on-harm"
    >
      <h2 className="t-heading">
        Federal inspectors found immediate jeopardy here
      </h2>
      <p className="t-body measure mt-2 text-on-harm">
        Immediate jeopardy is the most serious finding CMS issues. It means
        inspectors concluded residents were likely to suffer serious injury,
        harm, or death. This facility has {citations.length}{" "}
        {citations.length === 1 ? "such finding" : "such findings"} on record,
        from {years.join(", ")}.
      </p>
      <ul className="t-body mt-3 space-y-1 text-on-harm">
        {citations.map((c) => (
          <li key={c._id}>
            <span className="font-semibold tabular-nums">{fmtDate(c.surveyDate)}</span> —{" "}
            {c.tagDescription}
          </li>
        ))}
      </ul>
      <p className="t-meta mt-3 text-on-harm">
        Source: CMS Health Deficiencies, federal inspection record.
      </p>
    </section>
  );
}

function Stars({ value, label }: { value: number; label: string }) {
  return (
    <div>
      <dt className="t-label">{label}</dt>
      {/* The two cases are different kinds of text and cannot share a step. A
          rating is a figure; "not published by CMS" is a sentence, and setting
          it at the figure's line-height of 1 stacked its two lines on top of
          each other. */}
      <dd className={value > 0 ? "t-figure mt-1.5" : "t-body mt-1.5 text-muted"}>
        {value > 0 ? (
          <>
            {value}{" "}
            {/* Relative to the figure beside it, not a size of its own. Five
                stars set at 28px overflow the column on a 375px phone, and the
                numeral is the thing being read anyway. */}
            <span aria-hidden className="text-[0.55em] tracking-tight">
              {"★".repeat(value)}
            </span>
            <span className="sr-only">out of 5</span>
          </>
        ) : (
          // A Special Focus Facility has "" in this column. Zero stars would
          // be a lie of a different kind.
          "not published by CMS"
        )}
      </dd>
    </div>
  );
}

function CitationRow({ c }: { c: Citation }) {
  const harm = c.harmLevel as HarmLevel;
  return (
    <li className="border-t border-rule py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`t-meta rounded border px-2 py-0.5 font-semibold ${HARM_CHIP[harm]}`}
        >
          {HARM_LABEL[harm]}
        </span>
        <span className="t-meta">
          {SPREAD_LABEL[c.spread]} · Inspected {fmtDate(c.surveyDate)}
          {c.isComplaint ? " · Found after a complaint" : ""}
        </span>
      </div>

      {c.full ? (
        <p className="t-body measure mt-2">{c.full}</p>
      ) : (
        <p className="t-body measure mt-2 text-muted">
          <span className="inline-block h-3 w-3 animate-pulse rounded-full bg-rule-strong align-middle" />{" "}
          Translating this finding into plain English…
        </p>
      )}

      <details className="mt-2">
        <summary className="t-body link cursor-pointer text-muted">
          What the federal record says
        </summary>
        {/* The tag and the severity letter are codes, not words. They are set
            in the mono face so a family can see which part of this sentence
            they would type into a government website. */}
        <p className="t-meta measure mt-1.5">
          <span className="t-code">{c.tag}</span> · scope/severity{" "}
          <span className="t-code">{c.scopeSeverity}</span> — {c.tagDescription}
          {c.correctionDate
            ? ` Facility's date of correction: ${fmtDate(c.correctionDate)}.`
            : " No correction date on record."}
        </p>
      </details>
    </li>
  );
}

export function FacilityDetail({
  ccn,
  onBack,
}: {
  ccn: string;
  onBack?: () => void;
}) {
  const detail = useQuery(api.deficiencies.facilityDetail, { ccn });
  // Translation is triggered here — on view — and never during ingest.
  // The query above is reactive, so sentences appear in place as they land.
  useLazyTranslate(ccn, detail != null);
  // Firecrawl contact discovery and the local-news scan start on the same
  // event, for the same reason: neither is worth paying for until a family has
  // actually opened the facility.
  const { newsError } = useDiscovery(ccn, detail != null);

  if (detail === undefined) {
    return (
      <div className="mx-auto max-w-4xl px-6 py-20">
        <Loading what="Loading this facility's federal inspection record…" />
      </div>
    );
  }
  if (detail === null) {
    return (
      <div className="mx-auto max-w-4xl px-6 py-20">
        <Empty title={`No facility on file for CCN ${ccn}.`}>
          It may not be Medicare or Medicaid certified — assisted living and
          adult homes are licensed by the states and appear nowhere in the
          federal data — in which case there is no federal inspection record to
          read.
        </Empty>
        {onBack && (
          <button
            onClick={onBack}
            className="btn btn-quiet mt-4"
          >
            Back
          </button>
        )}
      </div>
    );
  }

  const { facility, counts, riskSummary, immediateJeopardy, worstFirst } = detail;

  return (
    <article className="mx-auto max-w-4xl px-6 py-10">
      {onBack && (
        <button
          onClick={onBack}
          className="link t-body mb-6"
        >
          ← All three facilities
        </button>
      )}

      <ImmediateJeopardyBanner citations={immediateJeopardy as Citation[]} />

      <h1 className="t-title">{facilityName(facility.name)}</h1>
      <p className="t-meta mt-2">
        {facility.city}, {facility.state} {facility.zip} · {facility.phone} ·{" "}
        {facility.certifiedBeds} certified beds · {facility.ownershipType}
      </p>

      <dl className="mt-6 grid grid-cols-2 gap-x-8 gap-y-6 border-y border-rule py-6 sm:grid-cols-4">
        <Stars value={facility.overallRating} label="CMS overall rating" />
        <Stars
          value={facility.healthInspectionRating}
          label="Health inspection rating"
        />
        <div>
          <dt className="t-label">Findings on record</dt>
          <dd className="t-figure mt-1.5">{counts.total}</dd>
        </div>
        <div>
          <dt className="t-label">Findings that harmed a resident</dt>
          <dd
            className={`t-figure mt-1.5 ${
              counts.actualHarm + counts.immediateJeopardy > 0 ? "text-harm" : ""
            }`}
          >
            {counts.actualHarm + counts.immediateJeopardy}
          </dd>
        </div>
      </dl>
      <Provenance>
        Federal record, CMS Provider Data Catalog. Synced{" "}
        {fmtDate(facility.lastCmsSync)}. Most recent inspection in this record:{" "}
        {fmtDate(detail.latestSurveyDate)}.
      </Provenance>

      <ContactPanel ccn={ccn} />

      <section className="mt-8">
        <h2 className="t-heading">What the record shows over time</h2>
        {riskSummary ? (
          <>
            <p className="t-body measure mt-2">{riskSummary.summary}</p>
            <Provenance>
              Pattern: {PATTERN_LABEL[riskSummary.pattern] ?? riskSummary.pattern}.
              Written by {riskSummary.model} from{" "}
              {counts.total} federal inspection findings. Not medical, legal, or
              financial advice.
            </Provenance>
          </>
        ) : (
          <p className="t-body mt-2 text-muted">
            Reading {counts.total} findings…
          </p>
        )}
      </section>

      <section className="mt-8">
        <h2 className="t-heading">
          Findings, most serious first
          <span className="t-meta ml-2">
            {counts.translated} of {worstFirst.length} translated
          </span>
        </h2>
        <ul className="mt-2">
          {worstFirst.map((c) => (
            <CitationRow key={c._id} c={c as Citation} />
          ))}
        </ul>
        {counts.total > worstFirst.length && (
          <Provenance>
            Showing the {worstFirst.length} most serious of {counts.total}{" "}
            findings on record.
          </Provenance>
        )}
      </section>

      <NewsPanel ccn={ccn} error={newsError} />
    </article>
  );
}
