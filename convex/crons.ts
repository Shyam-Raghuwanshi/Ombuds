import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

/**
 * One polite nudge, seventy-two hours after a letter went unanswered, and
 * never a second one (CLAUDE.md section 4).
 *
 * The sweep runs hourly rather than daily so a facility that has been silent
 * for exactly three days is chased within the hour rather than up to a day
 * later — which matters to a family who is choosing this week.
 */
const crons = cronJobs();

crons.interval(
  "nudge facilities that have not replied in 72 hours",
  { hours: 1 },
  internal.email.nudgeSweep,
  {},
);

export default crons;
