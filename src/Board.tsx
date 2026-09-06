import { useState } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { fmtDate } from "./severity";
import { facilityName } from "./facilityName";
import { QUESTION_KEYS, QUESTION_LABEL } from "../convex/lib/questions";
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
    <p className="t-label mb-2 sm:hidden">{children}</p>
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
    <div>
      <div className={`t-figure ${harm && value > 0 ? "text-harm" : ""}`}>
        {value}
      </div>
      <div className="t-label mt-2">{label}</div>
    </div>
  );
}

/**
 * How far through the campaign we are, as a bar.
 *
 * The counters above already carry these numbers, and a bar carries none that
 * they do not. It is here because this is the one thing on the screen that
 * moves on its own, and a number ticking from 6 to 7 is invisible at arm's
 * length while a bar advancing is not. A family glancing at a phone, and a
 * judge watching a recording, both read the bar before they read the digits.
 */
function CampaignProgress({
  replied,
  shortlisted,
  unreachable,
}: {
  replied: number;
  shortlisted: number;
  /**
   * Facilities that publish no email address anywhere. Counted from the rows
   * themselves rather than inferred from how many have been contacted so far:
   * for the first seconds of a campaign every row is still queued, and
   * treating "not yet written to" as "impossible to write to" would open the
   * demo by announcing that all twelve facilities are unreachable.
   */
  unreachable: number;
}) {
  if (shortlisted === 0) return null;

  // Denominated on the facilities we can write to at all, which is a fixed
  // number for the life of the campaign. A facility with no published address
  // can never reply, so leaving it in the denominator would hold the bar
  // permanently short of the end and report a finished campaign as an
  // unfinished one. They are named underneath instead of being folded into a
  // figure that makes the campaign look worse than it went.
  const reachable = Math.max(0, shortlisted - unreachable);
  const pct = reachable > 0 ? Math.min(100, (replied / reachable) * 100) : 0;
  const outstanding = Math.max(0, reachable - replied);

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="t-body tabular-nums">
          <span className="font-bold">{replied}</span> of the {reachable}{" "}
          facilities we can write to {replied === 1 ? "has" : "have"} answered
        </p>
        <p className="t-meta">
          {outstanding > 0
            ? `${outstanding} still to answer — replies land here as they arrive, nothing to refresh`
            : reachable > 0
              ? "Every facility we could reach has answered"
              : "Letters are still going out"}
        </p>
      </div>
      <div
        role="progressbar"
        aria-valuenow={replied}
        aria-valuemin={0}
        aria-valuemax={reachable}
        aria-label="Facilities that have replied"
        className="mt-2 h-2 w-full overflow-hidden rounded bg-sunk"
      >
        <div
          className="h-full bg-ink transition-[width] duration-700"
          style={{ width: `${pct}%` }}
        />
      </div>
      {unreachable > 0 && (
        <p className="t-meta measure mt-2">
          {unreachable}{" "}
          {unreachable === 1 ? "facility publishes" : "facilities publish"} no
          email address anywhere on the open web.{" "}
          {unreachable === 1 ? "It stays" : "They stay"} on the board below with
          the full inspection record and a phone number.
        </p>
      )}
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

      <h3 className="t-name">
        <button
          onClick={() => onOpenFacility(row.ccn)}
          className="link text-left"
        >
          {facilityName(row.facilityName)}
        </button>
      </h3>
      <p className="t-meta mt-1">
        {row.city}, {row.state}
        {row.overallRating > 0
          ? ` · ${row.overallRating} of 5 stars, CMS overall`
          : " · no CMS rating published"}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {row.immediateJeopardy > 0 && (
          <span className="surface-harm t-meta rounded border border-harm-edge bg-harm-solid px-2 py-0.5 font-bold text-on-harm">
            {row.immediateJeopardy} immediate jeopardy
          </span>
        )}
        {row.actualHarm > 0 && (
          <span className="t-meta rounded border border-harm-edge bg-harm-soft px-2 py-0.5 font-semibold text-harm">
            {row.actualHarm} finding{row.actualHarm === 1 ? "" : "s"} that
            harmed a resident
          </span>
        )}
        {row.abuseIcon && (
          <span className="t-meta rounded border border-harm-edge px-2 py-0.5 font-semibold text-harm">
            CMS abuse flag
          </span>
        )}
        {!flagged && !row.abuseIcon && (
          <span className="t-meta rounded border border-rule px-2 py-0.5">
            No harm on record
          </span>
        )}
      </div>

      <p className="t-meta mt-2">
        <span className="font-semibold">Federal record</span> ·{" "}
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
        <p className="t-body text-muted">{waitingLabel(row)}</p>

        {/* A facility with no address, or one whose address bounced, is not a
            dead end — the federal record still carries a telephone number, and
            that is the thing a family can act on. It leads, rather than
            trailing a repetition of the bad news. */}
        {(row.noEmailFound || row.status === "bounced") && row.phone && (
          <p className="t-body mt-2">
            Call{" "}
            <a className="link font-semibold tabular-nums" href={`tel:${row.phone}`}>
              {row.phone}
            </a>
            <span className="text-muted"> — from the federal record</span>
          </p>
        )}
        {row.status === "clarifying" && row.unansweredLabels.length > 0 && (
          <p className="t-body mt-2">
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

      <p className="t-name tabular-nums">{headline || "Replied"}</p>

      <ul className="t-body mt-2 space-y-1 tabular-nums">
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
        <p className="t-body mt-2 text-muted">
          Still unanswered: {row.unansweredLabels.join(", ").toLowerCase()}
        </p>
      )}

      {/* An emailed answer with a shelf life. Once the monthly sweep has
          marked it, the row says so in words rather than in a timestamp a
          reader has to do arithmetic on. */}
      {row.stale && (
        <p className="t-body mt-3 rounded-r border-l-4 border-rule-strong bg-sunk px-3 py-2">
          This was true {answerAge(row)}. Openings and waitlists move — worth
          asking again.
        </p>
      )}

      <p className="t-meta mt-2">
        <span className="font-semibold">Reported by the facility</span>
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
    <span className="rounded border border-rule-strong px-2 py-0.5 font-semibold">
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
      className={`card row-card overflow-hidden ${
        jeopardy ? "border-harm-edge" : ""
      }`}
    >
      {/* A ruled divider, not a gap. These two halves are different kinds of
          claim — one is what a federal inspector recorded, the other is what
          the facility says about itself — and separating them with whitespace
          alone left a reader to infer the boundary from alignment. On a phone
          the halves stack and the rule turns horizontal. */}
      <div className="grid p-5 sm:grid-cols-2">
        <div className="min-w-0 sm:pr-8">
          <Safety row={row} onOpenFacility={onOpenFacility} />
        </div>
        <div className="mt-5 min-w-0 border-t border-rule pt-5 sm:mt-0 sm:border-l sm:border-t-0 sm:pl-8 sm:pt-0">
          <Availability row={row} />
        </div>
      </div>

      {/* The provenance strip: who we wrote to, from where, and what became of
          it. A facility with no published address has no thread to open and no
          delivery status, so rather than leaving an empty bar the strip says
          what actually happened — the record has a phone number and the open
          web had nothing else. */}
      <div className="t-meta flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-rule bg-sunk px-5 py-3">
        {row.noEmailFound ? (
          <span>
            Searched the open web and found no address — it keeps its place here
            with its full inspection record.
          </span>
        ) : (
          <>
            <Rounds row={row} />
            {row.nudgeCount > 0 && (
              <span>Nudged once after three days of silence — never twice</span>
            )}
            {row.simulated && (
              <span className="rounded border border-rule-strong px-2 py-0.5 font-semibold">
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
              className="link ml-auto font-semibold text-ink"
            >
              Read the emails
              <span className="sr-only"> from {facilityName(row.facilityName)}</span>
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
      className="mt-6 rounded-lg border border-harm-edge bg-harm-soft p-5"
    >
      <h3 className="t-heading text-harm">
        New in the federal record since you shortlisted
      </h3>
      <ul className="t-body mt-3 space-y-2">
        {alerts.map((a) => (
          <li key={a.id}>
            <span className="font-bold">{facilityName(a.facilityName)}</span> was cited for{" "}
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
    <p className="t-meta measure mt-10 border-t border-rule pt-5">
      This search has cost{" "}
      <span className="font-bold text-ink">
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
        <h2 className="t-title">
          {search.label} family · {search.careLevel} care near{" "}
          <span className="tabular-nums">{search.zip}</span>
        </h2>
        <p className="t-body mt-3 tabular-nums text-muted">
          {search.budgetMax
            ? `Up to ${fmtMoney(search.budgetMax)} a month`
            : "No budget set"}
          {search.mustHaves.length > 0 && ` · ${search.mustHaves.join(" · ")}`}
        </p>

        {/* Where the campaign is writing from. A fact a judge should be able
            to check on screen rather than take on trust. */}
        <p className="t-body mt-2 text-muted">
          Writing from{" "}
          <span className="font-semibold text-ink">{search.inboxEmail}</span>
          {search.inboxMode === "shared"
            ? " — a shared inbox, because this AgentMail plan issues one"
            : " — this search's own inbox"}
        </p>

        {/* Demo mode used to be the tail of the sentence above, in muted grey,
            after the inbox address. It is the most important disclosure on the
            page: it is the reason no understaffed nursing home receives
            hackathon traffic. A deliberate choice that reads as an afterthought
            looks like a limitation instead of a decision. */}
        {search.demoMode && (
          <p className="t-body measure mt-3 rounded-r border-l-4 border-rule-strong bg-sunk px-4 py-3">
            <span className="font-bold">
              No real facility is emailed by this demo.
            </span>{" "}
            Every inquiry below is addressed to an inbox we own. These are real
            nursing homes with real inspection records, and they are understaffed
            places caring for vulnerable people — so the letters are real, the
            parsing is real, and the delivery is real, but the recipient is us.
          </p>
        )}

        {/* What was actually asked. The right-hand column is full of answers to
            questions the screen never stated, which left a reader to reverse
            engineer the questions from the shape of the replies. */}
        <div className="mt-5 border-t border-rule pt-4">
          <h3 className="t-label">
            The same five questions went to every facility
          </h3>
          <ul className="mt-2 flex flex-wrap gap-2">
            {QUESTION_KEYS.map((key) => (
              <li
                key={key}
                className="t-body rounded border border-rule px-2.5 py-1"
              >
                {QUESTION_LABEL[key]}
              </li>
            ))}
          </ul>
          <p className="t-meta measure mt-2">
            None of the five is published anywhere — not by CMS, not by the
            facility. Asking is the only way to find out, and a facility that
            skips one gets asked again.
          </p>
        </div>
      </header>

      {/* The live counter. Every number is a subscription.

          Boxed and set large because this is the only thing on the screen that
          changes without anyone touching it, and it has to be legible from
          across a room — a family looking up from a phone, a judge watching a
          recording at whatever size the player gives them. */}
      <div
        aria-live="polite"
        className="card mt-6 grid grid-cols-2 gap-x-6 gap-y-7 p-5 sm:grid-cols-3 sm:p-6 lg:grid-cols-6"
      >
        <Counter value={counters.shortlisted} label="shortlisted" />
        <Counter value={counters.contacted} label="contacted" />
        <Counter value={counters.replied} label="replied" />
        <Counter value={counters.openings} label="have openings" />
        <Counter value={counters.clarifying} label="asked again" />
        <Counter value={counters.flagged} label="flagged for harm" harm />
      </div>

      <CampaignProgress
        replied={counters.replied}
        shortlisted={counters.shortlisted}
        unreachable={rows.filter((r) => r.noEmailFound).length}
      />

      <ExportBoard searchId={searchId} />

      <Alerts alerts={alerts} />

      {/* The board has always been sorted — openings first, then by how badly
          the inspection record reads, then by CMS rating. Nothing said so, so
          twelve rows in a deliberate order were indistinguishable from twelve
          rows in no order, and the most useful thing about the ordering was
          invisible to the person it was for. */}
      <p className="t-body measure mt-8 text-muted">
        Ordered by availability first, then by inspection record: facilities
        with an opening rise to the top, and among those, the ones that have not
        harmed anyone come first.
      </p>

      {/* Sticky, so the reader can still tell which half is the federal record
          and which half is the facility's own account after scrolling past the
          heading. The distinction is the entire product and it cannot be
          allowed to scroll away. */}
      <div className="sticky top-0 z-10 mt-3 hidden border-y border-rule bg-paper py-2 sm:grid sm:grid-cols-2 sm:gap-10 sm:px-5">
        <span className="t-label">Safety · the federal inspection record</span>
        <span className="t-label">Availability · what the facility told us</span>
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

/**
 * Take the shortlist away.
 *
 * A family does not choose a care home in one sitting, and rarely alone. The
 * comparison has to survive leaving this screen — to be sorted by a daughter
 * who is not signed in, argued over by a brother in another state, taken to a
 * tour on a printout. A board that only exists behind a session is no use in
 * the conversation that actually decides this.
 *
 * The file is generated on demand rather than kept, because it would otherwise
 * be a snapshot going quietly stale in file storage while the board behind it
 * moved on.
 */
function ExportBoard({ searchId }: { searchId: Id<"searches"> }) {
  const exportCsv = useAction(api.exports.boardCsv);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function download() {
    setBusy(true);
    setError(null);
    void exportCsv({ searchId })
      .then((result) => {
        if (!result) {
          setError("That search is no longer available to download.");
          return;
        }
        // An anchor rather than assigning location: the file is served from
        // Convex storage on another origin, and navigating there would take
        // the family off their own board to a raw CSV.
        const a = document.createElement("a");
        a.href = result.url;
        a.download = result.filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
      })
      .catch((e) => {
        console.error("board export failed", e);
        setError(
          "We could not build that file just now. Nothing on the board has changed — trying again usually works.",
        );
      })
      .finally(() => setBusy(false));
  }

  return (
    <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2">
      <button
        onClick={download}
        disabled={busy}
        className="btn btn-quiet"
      >
        {busy ? "Building the file…" : "Download this comparison (CSV)"}
      </button>
      <span className="t-meta measure">
        Every facility, its inspection record, and what it told us — with the
        dates, so the two never get mistaken for each other.
      </span>
      {/* Not red. A file that failed to build is not a resident who was hurt,
          and this product has exactly one meaning for that colour. */}
      {error && <span className="t-meta w-full font-semibold text-ink">{error}</span>}
    </div>
  );
}
