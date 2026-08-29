import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

/**
 * The scheduled work.
 *
 * Four jobs, and none of them is decorative. Each one exists because something
 * a family needs to know changes on a clock they are not watching:
 *
 *   the nudge          a letter goes unanswered, and one polite note is the
 *                      difference between a blank row and an answer
 *   settling silence   after the nudge, silence becomes a fact worth stating
 *   the CMS refresh    the federal record is republished monthly, and a home on
 *                      a family's shortlist can pick up a harm citation between
 *                      the day they shortlist it and the day they sign
 *   stale answers      "we have a room now" was true in March and is not a fact
 *                      in July
 */
const crons = cronJobs();

// --- Email ------------------------------------------------------------------

/**
 * One polite nudge, seventy-two hours after a letter went unanswered, and never
 * a second one (CLAUDE.md section 4).
 *
 * The sweep runs hourly rather than daily so a facility that has been silent for
 * exactly three days is chased within the hour rather than up to a day later —
 * which matters to a family who is choosing this week.
 */
crons.interval(
  "nudge facilities that have not replied in 72 hours",
  { hours: 1 },
  internal.email.nudgeSweep,
  {},
);

/**
 * Nudged, and still nothing. The row settles at `no_response`, which is an
 * honest answer a family can act on rather than a spinner that never resolves.
 * Offset from the nudge sweep by running less often, so a nudge always gets its
 * own full window before this looks at it.
 */
crons.interval(
  "settle inquiries that stayed silent after their one nudge",
  { hours: 6 },
  internal.email.noResponseSweep,
  {},
);

// --- The federal record ------------------------------------------------------

/**
 * CMS republishes on the first of the month. We re-pull on the third, in the
 * small hours, because the publication is not instantaneous and a refresh that
 * races it just reads last month's file again.
 *
 * This diffs rather than overwrites: any harm-level citation that was not in
 * the previous month's record raises an alert on every active search watching
 * that facility. That is the difference between a data refresh and telling a
 * family something they need to know.
 */
crons.monthly(
  "re-ingest the CMS record and flag newly harmed facilities",
  { day: 3, hourUTC: 9, minuteUTC: 0 },
  internal.cms.refreshFacilitiesPage,
  { cursor: null },
);

/**
 * What a facility told us has a shelf life. Daily, in the small hours, because
 * a row crossing thirty days at 3am should be marked by breakfast.
 */
crons.daily(
  "mark facility answers older than 30 days as stale",
  { hourUTC: 10, minuteUTC: 30 },
  internal.email.staleSweep,
  {},
);

export default crons;
