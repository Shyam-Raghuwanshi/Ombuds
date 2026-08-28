import { ConvexError } from "convex/values";

/**
 * Firecrawl failures, turned into something we are willing to put on screen.
 *
 * The component throws `ConvexError`s carrying `{ code, status, path, message }`.
 * A blank card is the one outcome we will not ship: a family looking at this
 * board is making a decision under stress, and "nothing here" reads as "nothing
 * wrong here". Every failure below produces a sentence that says what happened
 * and what is still trustworthy on the page — the federal inspection record is
 * never affected by any of this, and the message says so.
 */

export type FirecrawlFailure = {
  /** Machine-readable, stored on the row and used to decide whether to retry. */
  code:
    | "out_of_credits"
    | "rate_limited"
    | "bad_key"
    | "timeout"
    | "not_found"
    | "blocked"
    | "unknown";
  status?: number;
  /** Shown to the user, verbatim. Written for a worried 55-year-old. */
  message: string;
  /** Whether trying again later could plausibly succeed. */
  retryable: boolean;
  /** Suggested delay before a retry, when retryable. */
  retryAfterMs?: number;
};

function statusOf(error: unknown): number | undefined {
  if (!(error instanceof ConvexError)) return undefined;
  const data = error.data as { status?: unknown } | undefined;
  return typeof data?.status === "number" ? data.status : undefined;
}

function messageOf(error: unknown): string {
  if (error instanceof ConvexError) {
    const data = error.data as { message?: unknown } | undefined;
    if (typeof data?.message === "string" && data.message) return data.message;
  }
  return error instanceof Error ? error.message : String(error);
}

export function describeFirecrawlError(error: unknown): FirecrawlFailure {
  const status = statusOf(error);
  const raw = messageOf(error);

  switch (status) {
    case 402:
      return {
        code: "out_of_credits",
        status,
        // Says what stopped AND what did not. The safety half of the product
        // is federal data we already hold; it does not depend on Firecrawl.
        message:
          "We have run out of web-search credits, so we could not look up this " +
          "facility's contact details. The inspection record below is the federal " +
          "record and is unaffected.",
        retryable: false,
      };
    case 429:
      return {
        code: "rate_limited",
        status,
        message:
          "Our web search is rate limited at the moment. We will try this " +
          "facility again shortly — the inspection record below is unaffected.",
        retryable: true,
        retryAfterMs: 60_000,
      };
    case 401:
    case 403:
      return {
        code: "bad_key",
        status,
        message:
          "Our web-search connection was rejected. Contact details are " +
          "unavailable for now; the inspection record below is unaffected.",
        retryable: false,
      };
    case 408:
    case 504:
      return {
        code: "timeout",
        status,
        message:
          "The facility's website did not respond in time. Their phone number " +
          "from the federal record is shown instead.",
        retryable: true,
        retryAfterMs: 30_000,
      };
    case 404:
      return {
        code: "not_found",
        status,
        message:
          "The page we found for this facility no longer exists. Their phone " +
          "number from the federal record is shown instead.",
        retryable: false,
      };
    default:
      break;
  }

  if (status !== undefined && status >= 500) {
    return {
      code: "blocked",
      status,
      message:
        "The facility's website could not be read right now. Their phone number " +
        "from the federal record is shown instead.",
      retryable: true,
      retryAfterMs: 60_000,
    };
  }

  if (/timeout|timed out|aborted/i.test(raw)) {
    return {
      code: "timeout",
      status,
      message:
        "The facility's website did not respond in time. Their phone number " +
        "from the federal record is shown instead.",
      retryable: true,
      retryAfterMs: 30_000,
    };
  }

  return {
    code: "unknown",
    status,
    message:
      "We could not read this facility's website. Their phone number from the " +
      "federal record is shown instead.",
    retryable: false,
  };
}

/**
 * True when the whole Firecrawl budget is gone, rather than one page failing.
 * Callers use this to stop a fan-out instead of burning through fifteen
 * facilities to collect fifteen identical failures.
 */
export function isFatalForBatch(failure: FirecrawlFailure): boolean {
  return failure.code === "out_of_credits" || failure.code === "bad_key";
}
