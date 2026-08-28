import { useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { fmtDate } from "./severity";
import {
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
 */

function Counter({
  value,
  label,
  alarming,
}: {
  value: number;
  label: string;
  alarming?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span
        className={`text-[22px] font-semibold tabular-nums ${
          alarming && value > 0 ? "text-[#b3241c] dark:text-[#ff8a80]" : ""
        }`}
      >
        {value}
      </span>
      <span className="text-[14px] text-[#5b6570] dark:text-[#9aa4ad]">
        {label}
      </span>
    </div>
  );
}

/** The left half: the federal record, and the date it was inspected. */
function Safety({ row }: { row: BoardRow }) {
  const flagged = row.actualHarm > 0 || row.immediateJeopardy > 0;
  return (
    <div className="min-w-0">
      <h3 className="text-[16px] font-semibold leading-snug">
        {row.facilityName}
      </h3>
      <p className="mt-0.5 text-[14px] text-[#5b6570] dark:text-[#9aa4ad]">
        {row.city}, {row.state}
        {row.overallRating > 0
          ? ` · ${row.overallRating}★ CMS overall`
          : " · no CMS rating published"}
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {row.immediateJeopardy > 0 && (
          <span className="rounded border border-[#7a1410] bg-[#b3241c] px-2 py-0.5 text-[13px] font-semibold text-white">
            {row.immediateJeopardy} immediate jeopardy
          </span>
        )}
        {row.actualHarm > 0 && (
          <span className="rounded border border-[#b3241c] bg-[#fdf0ef] px-2 py-0.5 text-[13px] font-medium text-[#b3241c] dark:border-[#7a1410] dark:bg-[#2a1210] dark:text-[#ff8a80]">
            {row.actualHarm} resident{row.actualHarm === 1 ? "" : "s"} actually
            harmed
          </span>
        )}
        {row.abuseIcon && (
          <span className="rounded border border-[#b3241c] px-2 py-0.5 text-[13px] font-medium text-[#b3241c] dark:border-[#7a1410] dark:text-[#ff8a80]">
            CMS abuse flag
          </span>
        )}
        {!flagged && !row.abuseIcon && (
          <span className="rounded border border-[#d8dce1] px-2 py-0.5 text-[13px] text-[#5b6570] dark:border-[#2b3236] dark:text-[#9aa4ad]">
            No harm on record
          </span>
        )}
      </div>

      <p className="mt-2 text-[13px] text-[#5b6570] dark:text-[#9aa4ad]">
        {row.latestSurveyDate
          ? `Federal record · inspected ${fmtDate(row.latestSurveyDate)}`
          : "Federal record · CMS Provider Data Catalog"}
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
        <p className="text-[15px] text-[#5b6570] dark:text-[#9aa4ad]">
          {waitingLabel(row)}
        </p>
        {row.noEmailFound && row.phone && (
          <p className="mt-1 text-[14px]">
            No address on their website — call{" "}
            <a className="underline underline-offset-4" href={`tel:${row.phone}`}>
              {row.phone}
            </a>
          </p>
        )}
        {row.status === "clarifying" && row.unansweredLabels.length > 0 && (
          <p className="mt-1 text-[14px]">
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
      <p className="text-[16px] font-semibold leading-snug">
        {headline || "Replied"}
      </p>

      <ul className="mt-1 space-y-0.5 text-[14px]">
        {waitlist && <li>{waitlist}</li>}
        {row.staffRatioNights && (
          <li>
            Nights {row.staffRatioNights}{" "}
            <span className="text-[#5b6570] dark:text-[#9aa4ad]">
              (their figure, not the federal one)
            </span>
          </li>
        )}
        {row.oneTimeFee !== null && (
          <li>{fmtMoney(row.oneTimeFee)} one-time move-in fee</li>
        )}
      </ul>

      {row.unansweredLabels.length > 0 && (
        <p className="mt-1 text-[14px] text-[#5b6570] dark:text-[#9aa4ad]">
          Still unanswered: {row.unansweredLabels.join(", ").toLowerCase()}
        </p>
      )}

      <p className="mt-2 text-[13px] text-[#5b6570] dark:text-[#9aa4ad]">
        Reported by the facility
        {row.lastInboundAt ? `, ${fmtTime(row.lastInboundAt)}` : ""}
        {row.rounds > 1 ? ` · after ${row.rounds} rounds` : ""}
        {lowConfidence(row.confidence) ? " · answer was vague" : ""}
      </p>
    </div>
  );
}

function Row({
  row,
  onOpenThread,
}: {
  row: BoardRow;
  onOpenThread: (id: Id<"inquiries">) => void;
}) {
  const jeopardy = row.immediateJeopardy > 0;
  return (
    <li
      className={`rounded border ${
        jeopardy
          ? "border-[#b3241c] dark:border-[#7a1410]"
          : "border-[#d8dce1] dark:border-[#2b3236]"
      }`}
    >
      <div className="grid gap-4 p-4 sm:grid-cols-2 sm:gap-8">
        <Safety row={row} />
        <Availability row={row} />
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[#d8dce1] px-4 py-2 text-[13px] text-[#5b6570] dark:border-[#2b3236] dark:text-[#9aa4ad]">
        {row.simulated && (
          <span className="rounded border border-[#d8dce1] px-1.5 py-0.5 font-medium dark:border-[#2b3236]">
            Simulated reply
          </span>
        )}
        {row.simulated && row.intendedTo && (
          <span>
            we did not write to {row.intendedTo} — routed to an inbox we own
          </span>
        )}
        {!row.simulated && !row.noEmailFound && row.toEmail && (
          <span>Emailed {row.toEmail}</span>
        )}
        {row.deliveryStatus && <span>AgentMail: {row.deliveryStatus}</span>}
        {!row.noEmailFound && (
          <button
            onClick={() => onOpenThread(row.inquiryId as Id<"inquiries">)}
            className="ml-auto underline underline-offset-4"
          >
            Read the emails
          </button>
        )}
      </div>
    </li>
  );
}

export function Board({
  searchId,
  onOpenThread,
}: {
  searchId: Id<"searches">;
  onOpenThread: (id: Id<"inquiries">) => void;
}) {
  const board = useQuery(api.searches.board, { searchId });

  if (board === undefined) {
    return (
      <p className="mx-auto max-w-7xl px-6 py-10 text-[#5b6570] dark:text-[#9aa4ad]">
        Loading the board…
      </p>
    );
  }
  if (board === null) {
    return (
      <p className="mx-auto max-w-7xl px-6 py-10 text-[#5b6570] dark:text-[#9aa4ad]">
        That search is not available.
      </p>
    );
  }

  const { search, counters, rows } = board;

  return (
    <section className="mx-auto max-w-7xl px-6 py-8">
      <header>
        <h2 className="text-[22px] font-semibold">
          {search.label} family · {search.careLevel} care near {search.zip}
        </h2>
        <p className="mt-1 text-[15px] text-[#5b6570] dark:text-[#9aa4ad]">
          {search.budgetMax
            ? `Up to ${fmtMoney(search.budgetMax)} a month`
            : "No budget set"}
          {search.mustHaves.length > 0 && ` · ${search.mustHaves.join(" · ")}`}
        </p>

        {/* Where the campaign is writing from, and whether anything real can
            leave the building. Both are facts a judge should be able to check
            on screen rather than take on trust. */}
        <p className="mt-2 text-[14px] text-[#5b6570] dark:text-[#9aa4ad]">
          Writing from{" "}
          <span className="font-medium text-[#14171a] dark:text-[#e8ebee]">
            {search.inboxEmail}
          </span>
          {search.inboxMode === "shared"
            ? " (shared inbox — this AgentMail plan issues one)"
            : " (this search's own inbox)"}
          {search.demoMode &&
            " · Demo mode: every inquiry is routed to an inbox we control, and no real facility is emailed."}
        </p>
      </header>

      {/* The live counter. Every number is a subscription. */}
      <div className="mt-6 flex flex-wrap items-baseline gap-x-8 gap-y-2 border-y border-[#d8dce1] py-4 dark:border-[#2b3236]">
        <Counter value={counters.shortlisted} label="shortlisted" />
        <Counter value={counters.contacted} label="contacted" />
        <Counter value={counters.replied} label="replied" />
        <Counter value={counters.openings} label="have openings" />
        <Counter value={counters.clarifying} label="asked again" />
        <Counter value={counters.flagged} label="flagged for harm" alarming />
      </div>

      <div className="mt-4 hidden gap-8 px-4 text-[13px] font-medium uppercase tracking-wide text-[#5b6570] sm:grid sm:grid-cols-2 dark:text-[#9aa4ad]">
        <span>Safety · the federal inspection record</span>
        <span>Availability · what the facility told us</span>
      </div>

      {rows.length === 0 ? (
        <p className="mt-4 rounded border border-[#d8dce1] p-6 text-[#5b6570] dark:border-[#2b3236] dark:text-[#9aa4ad]">
          No facilities on this shortlist yet.
        </p>
      ) : (
        <ul className="mt-2 space-y-3">
          {rows.map((row) => (
            <Row
              key={row.inquiryId}
              row={row as BoardRow}
              onOpenThread={onOpenThread}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
