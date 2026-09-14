import { DAY, HOUR, RateLimiter } from "@convex-dev/rate-limiter";
import { components } from "./_generated/api";

/**
 * What any one visitor, and everyone at once, is allowed to spend.
 *
 * A judge never sees a form because every visitor is signed in anonymously, and
 * that same property means "signed in" proves nothing: a new identity costs one
 * request. So each entry point that spends real money — an OpenAI call, a
 * Firecrawl credit, an AgentMail send — is bounded twice. Per visitor, so one
 * tab cannot drain the budget; and globally, because a script can mint a
 * thousand visitors (CLAUDE.md section 10: we pay for this ourselves).
 *
 * The global numbers are set well above anything a judging panel or a launch
 * post produces and well below what would empty the budget in a day. Nothing is
 * counted when the answer is already cached — a facility whose record is
 * translated, or whose contact page was read this week, costs nothing to view.
 */
const LIMITS = {
  // A campaign: one inbox, one letter, ~7 sends, ~$0.09 of model calls.
  campaignPerUser: { kind: "token bucket", rate: 3, period: HOUR, capacity: 3 },
  campaignGlobal: { kind: "token bucket", rate: 30, period: HOUR, capacity: 20 },
  campaignDaily: { kind: "fixed window", rate: 100, period: DAY },

  // Contact discovery, counted per facility actually sent to Firecrawl.
  discoveryPerUser: { kind: "token bucket", rate: 24, period: HOUR, capacity: 12 },
  discoveryGlobal: { kind: "token bucket", rate: 60, period: HOUR, capacity: 30 },
  discoveryDaily: { kind: "fixed window", rate: 240, period: DAY },

  // A local-news scan: one Firecrawl search and one large-model triage.
  newsPerUser: { kind: "token bucket", rate: 10, period: HOUR, capacity: 4 },
  newsGlobal: { kind: "token bucket", rate: 30, period: HOUR, capacity: 10 },
  newsDaily: { kind: "fixed window", rate: 120, period: DAY },

  // Translation, counted per uncached (tag, severity) pair.
  translatePerUser: { kind: "token bucket", rate: 20, period: HOUR, capacity: 10 },
  translatePairsGlobal: { kind: "token bucket", rate: 400, period: HOUR, capacity: 200 },

  // A facility's pattern summary, regenerated only when its record changed.
  summaryPerUser: { kind: "token bucket", rate: 10, period: HOUR, capacity: 5 },
  summaryGlobal: { kind: "token bucket", rate: 30, period: HOUR, capacity: 15 },

  // A state licensing crawl reads ~20 pages. It is also on a per-state cooldown.
  crawlDaily: { kind: "fixed window", rate: 3, period: DAY },

  // Each export writes a file to storage.
  exportPerUser: { kind: "token bucket", rate: 20, period: HOUR, capacity: 6 },
} as const;

export const rateLimiter = new RateLimiter(components.rateLimiter, LIMITS);

export type LimitName = keyof typeof LIMITS;

type LimitCtx = Parameters<typeof rateLimiter.limit>[0];

/**
 * Take from every bucket a piece of work draws on, and say whether it may run.
 *
 * Per-visitor buckets are skipped when there is no visitor yet: the front page
 * starts loading before anonymous sign-in has finished, and a cached record
 * must still render. The global buckets still apply, which is the point.
 */
export async function allow(
  ctx: LimitCtx,
  userId: string | null,
  rules: Array<{ name: LimitName; perUser?: boolean; count?: number }>,
): Promise<{ ok: boolean; retryAfter: number }> {
  for (const rule of rules) {
    if (rule.perUser && !userId) continue;
    const status = await rateLimiter.limit(ctx, rule.name, {
      key: rule.perUser ? userId! : undefined,
      count: rule.count,
    });
    if (!status.ok) return { ok: false, retryAfter: status.retryAfter ?? 0 };
  }
  return { ok: true, retryAfter: 0 };
}

/** The sentence a family reads when a limit is what stopped them. */
export function busyMessage(what: string, retryAfterMs: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterMs / 60_000));
  const when =
    minutes >= 120
      ? "later today"
      : `in about ${minutes} minute${minutes === 1 ? "" : "s"}`;
  return (
    `A lot of ${what} have been started in a short time, so we have paused ` +
    `new ones for a moment to keep this free to run. Please try again ${when}. ` +
    `Everything already on screen is unaffected.`
  );
}
