/**
 * Presentation rules for the board.
 *
 * The one rule that governs everything here: the left half of a row is the
 * federal inspection record and the right half is what a facility said about
 * itself in an email, and the two must never be made to look alike. Federal
 * figures carry the date they were inspected; emailed answers carry the date
 * the facility said them and the words "Reported by the facility". A family
 * has to be able to tell, at a glance, which kind of claim they are reading
 * (CLAUDE.md section 8).
 */

export type BoardRow = {
  inquiryId: string;
  ccn: string;
  facilityName: string;
  city: string;
  state: string;
  phone: string;
  overallRating: number;
  abuseIcon: boolean;
  actualHarm: number;
  immediateJeopardy: number;
  latestSurveyDate: number;
  status: string;
  deliveryStatus: string | null;
  rounds: number;
  followUpReason: string | null;
  nudgeCount: number;
  stale: boolean;
  answeredAt: number | null;
  rnHoursWeekend: number | null;
  specialFocusStatus: string | null;
  hasOpening: boolean | null;
  monthlyCostLow: number | null;
  monthlyCostHigh: number | null;
  oneTimeFee: number | null;
  waitlistWeeks: number | null;
  tourOffered: boolean | null;
  staffRatioNights: string | null;
  confidence: number | null;
  unanswered: string[];
  unansweredLabels: string[];
  replySummary: string | null;
  lastInboundAt: number | null;
  simulated: boolean;
  persona: string | null;
  personaLabel: string | null;
  toEmail: string;
  intendedTo: string | null;
  noEmailFound: boolean;
};

/**
 * What the right-hand column says while there is still nothing to report.
 *
 * "Waiting" is a real state that lasts hours or days in production and about a
 * minute here, and it has to look deliberate rather than broken. Each of these
 * says what actually happened, not "loading".
 */
export function waitingLabel(row: BoardRow): string {
  if (row.noEmailFound) return "No email address published";
  switch (row.status) {
    case "queued":
      return "Queued to send";
    case "sent":
      return "Sent, waiting for a reply";
    case "delivered":
      return "Delivered, waiting for a reply";
    case "replied":
      return "Reply received, reading it";
    case "clarifying":
      return row.followUpReason === "low_confidence"
        ? "Their answer was too vague — asking for a figure"
        : "They left something out — asking again";
    case "bounced":
      return "The address bounced";
    case "no_response":
      return row.nudgeCount > 0
        ? "No reply, and no reply to our one follow-up note"
        : "No reply after 72 hours";
    default:
      return "Waiting";
  }
}

/** True once there is something a family can actually act on. */
export function hasAnswers(row: BoardRow): boolean {
  return (
    row.hasOpening !== null ||
    row.monthlyCostLow !== null ||
    row.waitlistWeeks !== null ||
    row.tourOffered !== null ||
    row.staffRatioNights !== null
  );
}

export function fmtMoney(n: number): string {
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

/** "$6,200/mo" for a single figure, "$5,700-$6,900/mo" for a range. */
export function fmtCost(low: number | null, high: number | null): string | null {
  if (low === null && high === null) return null;
  if (low !== null && high !== null && low !== high) {
    return `${fmtMoney(low)}–${fmtMoney(high)}/mo`;
  }
  return `${fmtMoney((low ?? high) as number)}/mo`;
}

/**
 * Weeks are what the parser stores because facilities answer in both weeks and
 * months. Families think in months once it is past a couple of months.
 */
export function fmtWaitlist(weeks: number | null): string | null {
  if (weeks === null) return null;
  if (weeks === 0) return "No waitlist";
  if (weeks < 9) return `${Math.round(weeks)} week${weeks === 1 ? "" : "s"} wait`;
  return `About ${Math.round(weeks / 4.35)} months wait`;
}

export function fmtWhen(ms: number | null): string {
  if (!ms) return "";
  return new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

export function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * A confidence score is only worth showing when it is low enough to change what
 * a family does with the number next to it.
 */
export function lowConfidence(confidence: number | null): boolean {
  return confidence !== null && confidence < 0.6;
}

/**
 * How old an emailed answer is, in the words a family would use.
 *
 * Shown next to every figure that came from a facility rather than from the
 * federal record. Once the stale sweep has marked a row, the phrasing stops
 * being a timestamp and starts being a warning, because at that point the
 * number on screen is no longer something to plan around.
 */
export function answerAge(row: BoardRow): string | null {
  if (!row.answeredAt) return null;
  const days = Math.floor((Date.now() - row.answeredAt) / 86_400_000);
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.round(days / 30.4);
  return `${months} month${months === 1 ? "" : "s"} ago`;
}

/**
 * The federal staffing figure, phrased so it can sit next to a facility's own
 * claim without either being mistaken for the other.
 *
 * CMS publishes registered nurse hours per resident per day at the weekend.
 * That is not the same unit as "one caregiver to twelve residents", and we do
 * not pretend it is: both are shown, each labelled with where it came from, and
 * the reader draws their own conclusion.
 */
export function federalStaffing(row: BoardRow): string | null {
  if (row.rnHoursWeekend === null) return null;
  return `${row.rnHoursWeekend.toFixed(2)} RN hours per resident on weekends`;
}
