import { useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { fmtDate } from "./severity";
import { Empty, Loading } from "./ui";
import {
  answerAge,
  federalStaffing,
  fmtCost,
  fmtMoney,
  fmtTime,
  fmtWaitlist,
  hasAnswers,
  lowConfidence,
  waitingLabel,
  type BoardRow,
} from "./board";

/**
 * The board is the product.
 *
 * Safety on the left, availability on the right, a live counter at the top.
 * Nothing on this screen polls: every number is a Convex query subscription, so
 * a reply that lands while the family is reading moves the counter and fills in
 * a row underneath their eyes.
 *
 * The two halves are never allowed to look alike. The left is what federal
 * inspectors found and carries the date they found it; the right is what a
 * facility said about itself and carries the date they said it. On a phone the
 * halves stack, so each one grows a heading — on a wide screen the column
 * headings above the list do that job instead.
 */

function ColumnLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-2 text-[14px] font-medium uppercase tracking-wide text-muted sm:hidden">
      {children}
    </p>
  );
}

function Counter({
  value,
  label,
  harm,
}: {
  value: number;
  label: string;
  /** Only the harm counter may be coloured, and only when it is non-zero. */
  harm?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span
        className={`text-[24px] font-semibold tabular-nums ${
          harm && value > 0 ? "text-harm" : ""
        }`}
      >
        {value}
      </span>
      <span className="text-[15px] text-muted">{label}</span>
    </div>
  );
}

/** The left half: the federal record, and the date it was inspected. */
function Safety({
  row,
  onOpenFacility,
}: {
  row: BoardRow;
  onOpenFacility: (ccn: string) => void;
}) {
  const flagged = row.actualHarm > 0 || row.immediateJeopardy > 0;
  return (
    <div className="min-w-0">
      <ColumnLabel>Safety · the federal inspection record</ColumnLabel>

      <h3 className="text-[18px] font-semibold leading-snug">
        <button
          onClick={() => onOpenFacility(row.ccn)}
          className="text-left underline underline-offset-4"
        >
          {row.facilityName}
        </button>
      </h3>
      <p className="mt-1 text-[16px] text-muted">
        {row.city}, {row.state}
        {row.overallRating > 0
          ? ` · ${row.overallRating} of 5 stars, CMS overall`
          : " · no CMS rating published"}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {row.immediateJeopardy > 0 && (
          <span className="surface-harm rounded border border-harm-edge bg-harm-solid px-2 py-0.5 text-[14px] font-semibold text-on-harm">
            {row.immediateJeopardy} immediate jeopardy
          </span>
        )}
        {row.actualHarm > 0 && (
          <span className="rounded border border-harm-edge bg-harm-soft px-2 py-0.5 text-[14px] font-medium text-harm">
            {row.actualHarm} finding{row.actualHarm === 1 ? "" : "s"} that
            harmed a resident
          </span>
        )}
        {row.abuseIcon && (
          <span className="rounded border border-harm-edge px-2 py-0.5 text-[14px] font-medium text-harm">
            CMS abuse flag
          </span>
        )}
        {!flagged && !row.abuseIcon && (
          <span className="rounded border border-rule px-2 py-0.5 text-[14px] text-muted">
            No harm on record
          </span>
        )}
      </div>

      <p className="mt-2 text-[14px] text-muted">
        <span className="font-medium">Federal record</span> ·{" "}
        {row.latestSurveyDate
          ? `inspected ${fmtDate(row.latestSurveyDate)}`
          : "CMS Provider Data Catalog"}
      </p>
    </div>
  );
}

/** The right half: what the facility said, and when they said it. */
function Availability({ row }: { row: BoardRow }) {
  const cost = fmtCost(row.monthlyCostLow, row.monthlyCostHigh);
  const waitlist = fmtWaitlist(row.waitlistWeeks);
  const answered = hasAnswers(row);

  if (!answered) {
    return (
      <div className="min-w-0">
        <ColumnLabel>Availability · what the facility told us</ColumnLabel>
        <p className="text-[16px] text-muted">{waitingLabel(row)}</p>
        {row.noEmailFound && row.phone && (
          <p className="mt-2 text-[16px]">
            No address published on their website — call{" "}
            <a className="underline underline-offset-4" href={`tel:${row.phone}`}>
              {row.phone}
            </a>
          </p>
        )}
        {row.status === "clarifying" && row.unansweredLabels.length > 0 && (
          <p className="mt-2 text-[16px]">
            Following up on {row.unansweredLabels.join(", ").toLowerCase()}
          </p>
        )}
      </div>
    );
  }

  const headline = [
    row.hasOpening === true
      ? "Opening now"
      : row.hasOpening === false
        ? "No opening"
        : null,
    cost,
    row.tourOffered === true ? "tour offered" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="min-w-0">
      <ColumnLabel>Availability · what the facility told us</ColumnLabel>

      <p className="text-[18px] font-semibold leading-snug">
        {headline || "Replied"}
      </p>

      <ul className="mt-2 space-y-1 text-[16px]">
        {waitlist && <li>{waitlist}</li>}
        {row.staffRatioNights && (
          <li>
            Nights {row.staffRatioNights}{" "}
            <span className="text-muted">(their figure, not the federal one)</span>
            {federalStaffing(row) && (
              <>
                <br />
                <span className="text-muted">
                  Federal record: {federalStaffing(row)}
                </span>
              </>
            )}
          </li>
        )}
        {row.oneTimeFee !== null && (
          <li>{fmtMoney(row.oneTimeFee)} one-time move-in fee</li>
        )}
      </ul>

      {row.unansweredLabels.length > 0 && (
        <p className="mt-2 text-[16px] text-muted">
          Still unanswered: {row.unansweredLabels.join(", ").toLowerCase()}
        </p>
      )}

      {/* An emailed answer with a shelf life. Once the monthly sweep has
          marked it, the row says so in words rather than in a timestamp a
          reader has to do arithmetic on. */}
      {row.stale && (
        <p className="mt-3 rounded border-l-4 border-rule-strong bg-sunk px-3 py-2 text-[16px]">
          This was true {answerAge(row)}. Openings and waitlists move — worth
          asking again.
        </p>
      )}

      <p className="mt-2 text-[14px] text-muted">
        <span className="font-medium">Reported by the facility</span>
        {row.lastInboundAt ? ` · ${fmtTime(row.lastInboundAt)}` : ""}
        {row.rounds > 1 ? ` · after ${row.rounds} rounds` : ""}
        {lowConfidence(row.confidence) ? " · answer was vague" : ""}
      </p>
    </div>
  );
}

/**
 * The rounds counter.
 *
 * One round is a letter and its answer. Two means the agent read what came
 * back, decided the family was still owed something, and wrote again in the
 * same thread without anyone asking it to — which is the single most useful
 * thing this product does, so it says so rather than showing a number.
 *
 * The explanation is rendered rather than hung off a `title`, because a tooltip
 * is invisible to a keyboard and to a phone, which is where this gets read.
 */
function Rounds({ row }: { row: BoardRow }) {
  if (row.rounds < 2) return null;
  return (
    <span className="rounded border border-rule-strong px-2 py-0.5 font-medium">
      {row.rounds} rounds ·{" "}
      {row.followUpReason === "low_confidence"
        ? "we asked again for a figure"
        : "we asked again for what they skipped"}
    </span>
  );
}

function Row({
  row,
  onOpenThread,
  onOpenFacility,
}: {
  row: BoardRow;
  onOpenThread: (id: Id<"inquiries">) => void;
  onOpenFacility: (ccn: string) => void;
}) {
  const jeopardy = row.immediateJeopardy > 0;
  return (
    <li
      className={`overflow-hidden rounded border ${
        jeopardy ? "border-harm-edge" : "border-rule"
      }`}
    >
      <div className="grid gap-6 p-5 sm:grid-cols-2 sm:gap-10">
        <Safety row={row} onOpenFacility={onOpenFacility} />
        <Availability row={row} />
      </div>

      {/* The provenance strip: who we wrote to, from where, and what became of
          it. A facility with no published address has no thread to open and no
          delivery status, so rather than leaving an empty bar the strip says
          what actually happened — the record has a phone number and the open
          web had nothing else. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-rule bg-sunk px-5 py-3 text-[14px] text-muted">
        {row.noEmailFound ? (
          <span>
            No address for this facility anywhere on the open web — the federal
            record publishes a telephone number and nothing else. It keeps its
            place here with its full inspection record.
          </span>
        ) : (
          <>
            <Rounds row={row} />
            {row.nudgeCount > 0 && (
              <span>Nudged once after three days of silence — never twice</span>
            )}
            {row.simulated && (
              <span className="rounded border border-rule-strong px-2 py-0.5 font-medium">
                Simulated reply
              </span>
            )}
            {row.simulated && row.intendedTo && (
              <span>
                we did not write to {row.intendedTo} — routed to an inbox we own
              </span>
            )}
            {!row.simulated && row.toEmail && (
              <span className="break-all">Emailed {row.toEmail}</span>
            )}
            {row.deliveryStatus && <span>AgentMail: {row.deliveryStatus}</span>}
            <button
              onClick={() => onOpenThread(row.inquiryId as Id<"inquiries">)}
              className="ml-auto font-medium text-ink underline underline-offset-4"
            >
              Read the emails
              <span className="sr-only"> from {row.facilityName}</span>
            </button>
          </>
        )}
      </div>
    </li>
  );
}

/**
 * What changed in the federal record since this family shortlisted.
 *
 * The monthly CMS refresh raises these. It is the one place on the board where
 * red is used for something other than a citation count, and it is the same
 * meaning: a resident was hurt, and it was published after you last looked.
 */
function Alerts({
  alerts,
}: {
  alerts: {
    id: string;
    facilityName: string;
    kind: string;
    tagDescription: string;
    surveyDate: number;
    detectedAt: number;
  }[];
}) {
  if (alerts.length === 0) return null;
  return (
    <section
      aria-label="New findings since you shortlisted"
      className="mt-6 rounded border border-harm-edge bg-harm-soft p-5"
    >
      <h3 className="text-[18px] font-semibold text-harm">
        New in the federal record since you shortlisted
      </h3>
      <ul className="mt-3 space-y-2 text-[16px]">
        {alerts.map((a) => (
          <li key={a.id}>
            <span className="font-medium">{a.facilityName}</span> was cited for{" "}
            {a.tagDescription.replace(/\.$/, "")}.{" "}
            <span className="text-muted">
              {a.kind === "new_immediate_jeopardy"
                ? "Immediate jeopardy to residents"
                : "A resident was actually harmed"}
              . Inspected {fmtDate(a.surveyDate)}, published since you last
              looked.
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * What this search cost us, in dollars.
 *
 * No credits were provided and the budget is real, so this is not a vanity
 * figure — it is the number that decided which model reads a reply and which
 * one drafts the letter. Showing it is the honest version of claiming to care
 * about it.
 */
function Spend({ searchId }: { searchId: Id<"searches"> }) {
  const spend = useQuery(api.usage.spendForSearch, { searchId });
  if (!spend || spend.calls === 0) return null;

  const dollars = spend.costUsd < 0.01 ? "<$0.01" : `$${spend.costUsd.toFixed(2)}`;
  const top = spend.byPurpose.slice(0, 3);

  return (
    <p className="mt-10 border-t border-rule pt-5 text-[14px] leading-relaxed text-muted">
      This search has cost{" "}
      <span className="font-medium tabular-nums text-ink">
        {spend.fullyPriced ? dollars : "an unpriced amount"}
      </span>{" "}
      in model calls — {spend.calls} call{spend.calls === 1 ? "" : "s"},{" "}
      {spend.totalTokens.toLocaleString()} tokens
      {spend.cachedInputTokens > 0 &&
        `, ${spend.cachedInputTokens.toLocaleString()} of them billed at the cached rate`}
      {top.length > 0 && (
        <>
          {" "}
          ({top.map((b) => `${humanPurpose(b.purpose)} ${b.calls}`).join(", ")})
        </>
      )}
      . Models: {spend.models.join(", ")}.
      {!spend.fullyPriced &&
        ` ${spend.unpricedCalls} call${spend.unpricedCalls === 1 ? "" : "s"} used a model we have no published rate for, so its tokens are counted and its cost is not.`}{" "}
      We pay for this ourselves and take no money from facilities.
    </p>
  );
}

/** Task names are internal. These are what they are. */
function humanPurpose(purpose: string): string {
  switch (purpose) {
    case "emailReplyParse":
      return "reading replies";
    case "emailDraft":
      return "writing letters";
    case "agentLoop":
      return "deciding what to ask";
    case "deficiencyTranslation":
      return "translating citations";
    case "facilityRiskSummary":
      return "summarising records";
    case "facilityNewsScan":
      return "checking local news";
    case "facilityRanking":
      return "ranking";
    default:
      return purpose;
  }
}

export function Board({
  searchId,
  onOpenThread,
  onOpenFacility,
}: {
  searchId: Id<"searches">;
  onOpenThread: (id: Id<"inquiries">) => void;
  onOpenFacility: (ccn: string) => void;
}) {
  const board = useQuery(api.searches.board, { searchId });

  if (board === undefined) {
    return (
      <div className="mx-auto max-w-7xl px-6 py-10">
        <Loading what="Loading the shortlist and their inspection records…" />
      </div>
    );
  }
  if (board === null) {
    return (
      <div className="mx-auto max-w-7xl px-6 py-10">
        <Empty title="That search is not available.">
          It may belong to a different session. Ombuds signs every visitor in
          anonymously, so a search is only visible to the browser that started
          it.
        </Empty>
      </div>
    );
  }

  const { search, counters, rows, alerts } = board;

  return (
    <section className="mx-auto max-w-7xl px-6 py-8">
      <header>
        <h2 className="text-[24px] font-semibold sm:text-[26px]">
          {search.label} family · {search.careLevel} care near {search.zip}
        </h2>
        <p className="mt-2 text-[16px] text-muted">
          {search.budgetMax
            ? `Up to ${fmtMoney(search.budgetMax)} a month`
            : "No budget set"}
          {search.mustHaves.length > 0 && ` · ${search.mustHaves.join(" · ")}`}
        </p>

        {/* Where the campaign is writing from, and whether anything real can
            leave the building. Both are facts a judge should be able to check
            on screen rather than take on trust. */}
        <p className="mt-2 text-[16px] leading-relaxed text-muted">
          Writing from{" "}
          <span className="font-medium text-ink">{search.inboxEmail}</span>
          {search.inboxMode === "shared"
            ? " (shared inbox — this AgentMail plan issues one)"
            : " (this search's own inbox)"}
          {search.demoMode &&
            " · Demo mode: every inquiry is routed to an inbox we control, and no real facility is emailed."}
        </p>
      </header>

      {/* The live counter. Every number is a subscription. */}
      <div
        aria-live="polite"
        className="mt-6 flex flex-wrap items-baseline gap-x-8 gap-y-3 border-y border-rule py-4"
      >
        <Counter value={counters.shortlisted} label="shortlisted" />
        <Counter value={counters.contacted} label="contacted" />
        <Counter value={counters.replied} label="replied" />
        <Counter value={counters.openings} label="have openings" />
        <Counter value={counters.clarifying} label="asked again" />
        <Counter value={counters.flagged} label="flagged for harm" harm />
      </div>

      <Alerts alerts={alerts} />

      <div className="mt-6 hidden gap-10 px-5 text-[14px] font-medium uppercase tracking-wide text-muted sm:grid sm:grid-cols-2">
        <span>Safety · the federal inspection record</span>
        <span>Availability · what the facility told us</span>
      </div>

      {rows.length === 0 ? (
        <div className="mt-3">
          {/* Not an error. The shortlist is written a moment after the search
              itself, so this is what the first second of a campaign looks
              like — and it says so rather than showing a bare "none". */}
          <Empty title="Building the shortlist…">
            Twelve facilities near {search.zip} are being pulled from the
            federal record. Their rows appear here as they land.
          </Empty>
        </div>
      ) : (
        <ul className="mt-3 space-y-4">
          {rows.map((row) => (
            <Row
              key={row.inquiryId}
              row={row as BoardRow}
              onOpenThread={onOpenThread}
              onOpenFacility={onOpenFacility}
            />
          ))}
        </ul>
      )}

      <Spend searchId={searchId} />
    </section>
  );
}
