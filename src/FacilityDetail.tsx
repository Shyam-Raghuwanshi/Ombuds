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
      className="surface-harm mb-8 rounded border-l-4 border-harm-edge bg-harm-solid px-5 py-4 text-on-harm"
    >
      <h2 className="text-lg font-semibold">
        Federal inspectors found immediate jeopardy here
      </h2>
      <p className="mt-1 max-w-3xl text-[16px] leading-relaxed text-on-harm">
        Immediate jeopardy is the most serious finding CMS issues. It means
        inspectors concluded residents were likely to suffer serious injury,
        harm, or death. This facility has {citations.length}{" "}
        {citations.length === 1 ? "such finding" : "such findings"} on record,
        from {years.join(", ")}.
      </p>
      <ul className="mt-3 space-y-1 text-[16px] text-on-harm">
        {citations.map((c) => (
          <li key={c._id}>
            <span className="font-medium">{fmtDate(c.surveyDate)}</span> —{" "}
            {c.tagDescription}
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[14px] text-on-harm">
        Source: CMS Health Deficiencies, federal inspection record.
      </p>
    </section>
  );
}

function Stars({ value, label }: { value: number; label: string }) {
  return (
    <div>
      <dt className="text-[15px] text-muted">{label}</dt>
      <dd className="text-[16px] font-medium">
        {value > 0 ? (
          <>
            {value} <span aria-hidden>{"★".repeat(value)}</span>
            <span className="sr-only">out of 5</span>
          </>
        ) : (
          // A Special Focus Facility has "" in this column. Zero stars would
          // be a lie of a different kind.
          <span className="text-muted">
            not published by CMS
          </span>
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
          className={`rounded border px-2 py-0.5 text-[14px] font-medium ${HARM_CHIP[harm]}`}
        >
          {HARM_LABEL[harm]}
        </span>
        <span className="text-[15px] text-muted">
          {SPREAD_LABEL[c.spread]} · Inspected {fmtDate(c.surveyDate)}
          {c.isComplaint ? " · Found after a complaint" : ""}
        </span>
      </div>

      {c.full ? (
        <p className="mt-2 max-w-3xl text-[16px] leading-relaxed">{c.full}</p>
      ) : (
        <p className="mt-2 max-w-3xl text-[16px] leading-relaxed text-muted">
          <span className="inline-block h-3 w-3 animate-pulse rounded-full bg-rule-strong align-middle" />{" "}
          Translating this finding into plain English…
        </p>
      )}

      <details className="mt-2">
        <summary className="cursor-pointer text-[16px] text-muted underline underline-offset-2">
          What the federal record says
        </summary>
        <p className="mt-1 max-w-3xl text-[16px] text-muted">
          {c.tag} · scope/severity {c.scopeSeverity} — {c.tagDescription}
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
            className="mt-4 rounded border border-rule-strong px-4 py-2 text-[16px] font-medium"
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
          className="mb-6 text-[16px] underline underline-offset-4"
        >
          ← All three facilities
        </button>
      )}

      <ImmediateJeopardyBanner citations={immediateJeopardy as Citation[]} />

      <h1 className="text-3xl font-semibold leading-tight">
        {facilityName(facility.name)}
      </h1>
      <p className="mt-2 text-[16px] text-muted">
        {facility.city}, {facility.state} {facility.zip} · {facility.phone} ·{" "}
        {facility.certifiedBeds} certified beds · {facility.ownershipType}
      </p>

      <dl className="mt-6 grid grid-cols-2 gap-x-8 gap-y-4 border-y border-rule py-5 sm:grid-cols-4">
        <Stars value={facility.overallRating} label="CMS overall rating" />
        <Stars
          value={facility.healthInspectionRating}
          label="Health inspection rating"
        />
        <div>
          <dt className="text-[15px] text-muted">
            Findings on record
          </dt>
          <dd className="text-[16px] font-medium">{counts.total}</dd>
        </div>
        <div>
          <dt className="text-[15px] text-muted">
            Findings that harmed a resident
          </dt>
          <dd
            className={`text-[16px] font-medium ${
              counts.actualHarm + counts.immediateJeopardy > 0
                ? "text-harm"
                : ""
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
        <h2 className="text-xl font-semibold">What the record shows over time</h2>
        {riskSummary ? (
          <>
            <p className="mt-2 max-w-3xl text-[17px] leading-relaxed">
              {riskSummary.summary}
            </p>
            <Provenance>
              Pattern: {PATTERN_LABEL[riskSummary.pattern] ?? riskSummary.pattern}.
              Written by {riskSummary.model} from{" "}
              {counts.total} federal inspection findings. Not medical, legal, or
              financial advice.
            </Provenance>
          </>
        ) : (
          <p className="mt-2 text-[16px] text-muted">
            Reading {counts.total} findings…
          </p>
        )}
      </section>

      <section className="mt-8">
        <h2 className="text-xl font-semibold">
          Findings, most serious first
          <span className="ml-2 text-[16px] font-normal text-muted">
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
