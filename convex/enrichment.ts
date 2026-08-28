import { v } from "convex/values";
import { z } from "zod";
import { Workpool } from "@convex-dev/workpool";
import { FirecrawlClient } from "@firecrawl/firecrawl-convex";
import type { ActionCtx } from "./_generated/server";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { components, internal } from "./_generated/api";
import {
  describeFirecrawlError,
  isFatalForBatch,
  type FirecrawlFailure,
} from "./lib/firecrawlErrors";
import {
  EXCLUDE_DOMAINS,
  harvestEmails,
  hostnameOf,
  originOf,
  pickBestEmail,
  rankContactPages,
  scoreCandidateSite,
  siteSearchQuery,
} from "./lib/contact";

/**
 * Firecrawl contact discovery — the join between the federal record and an inbox.
 *
 * This file exists because of one gap in the CMS data: there is no website
 * column and no email column, only a telephone number (CLAUDE.md section 6,
 * fact 4). Every facility in the country is published with its inspection
 * history and no way to write to it. So the pipeline is:
 *
 *   search()  find the facility's own website at all — CMS never tells us
 *   map()     find the admissions or contact page on that website
 *   scrape()  read the address, care levels, room types, pricing, amenities
 *
 * Firecrawl's output is the direct input to AgentMail. Without this step there
 * is no path from a federal provider number to an email thread, which is why
 * this is load-bearing rather than decorative.
 *
 * It fails often, and that is expected: many nursing homes have no website, a
 * broken one, or publish no address. A realistic hit rate is 50-70%. A facility
 * we cannot reach is marked `no_email_found`, shown with its CMS phone number,
 * and stays on the board with its safety record intact. Dropping it would
 * reproduce exactly the filtering we exist to undo.
 */

const firecrawl = new FirecrawlClient(components.firecrawl);

// Three at a time. Enough that a fifteen-facility shortlist finishes while the
// family is still reading the first row; few enough that we never trip
// Firecrawl's rate limit and turn a whole board into 429s.
const enrichmentPool = new Workpool(components.enrichmentPool, {
  maxParallelism: 3,
});

/** Reuse Firecrawl's cache for a week. A contact page does not change hourly. */
const SCRAPE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Don't re-run discovery for a facility we already resolved this recently. */
const REDISCOVER_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
/** Hard per-facility budget. One search, one map, at most two scrapes. */
const MAX_SCRAPES_PER_FACILITY = 2;

// =============================================================================
// What Firecrawl is asked to extract
// =============================================================================

const EXTRACTION_PROMPT =
  "This is a page from a senior care facility's own website. Extract only what " +
  "is actually written on the page. Do not guess, do not infer, and do not " +
  "reuse an example. contactEmail: the email address a prospective resident's " +
  "family would write to about moving in — prefer an admissions or general " +
  "enquiries address; return null if the page shows no email address at all. " +
  "careLevels: the levels of care offered, in the page's own words (for " +
  "example independent living, assisted living, memory care, skilled nursing, " +
  "respite, rehabilitation). roomTypes: the accommodation types offered (for " +
  "example private room, semi-private, studio, one bedroom). amenities: " +
  "amenities and services listed. publishedPricing: any monthly price or price " +
  "range printed on the page, exactly as written; null if no price is shown.";

/**
 * Passed to Firecrawl as the JSON-format schema. Nothing is `required`: a page
 * with no email must be allowed to come back with no email, because the
 * alternative is a model filling the field in to satisfy a schema.
 */
const EXTRACTION_JSON_SCHEMA = {
  type: "object",
  properties: {
    contactEmail: {
      type: "string",
      description: "Admissions or general enquiries email, exactly as printed.",
    },
    careLevels: { type: "array", items: { type: "string" } },
    roomTypes: { type: "array", items: { type: "string" } },
    amenities: { type: "array", items: { type: "string" } },
    publishedPricing: {
      type: "string",
      description: "Monthly price or range as printed, e.g. '$4,200 - $6,500'.",
    },
  },
} as const;

/**
 * Firecrawl's extraction is still a model's output, so it is validated here
 * before it touches the database — the same rule the rest of the product
 * follows for its own model calls (CLAUDE.md section 9).
 */
const extractedSchema = z.object({
  contactEmail: z.string().nullish(),
  careLevels: z.array(z.string()).nullish(),
  roomTypes: z.array(z.string()).nullish(),
  amenities: z.array(z.string()).nullish(),
  publishedPricing: z.string().nullish(),
});

/**
 * Extractors sometimes answer "no value" with the WORD null, or with "N/A", or
 * with "not listed" — a string that would otherwise be shown to a family as
 * this facility's published price. Treat all of them as absent.
 */
const NULLISH_TEXT = new Set([
  "null", "none", "n/a", "na", "unknown", "not listed", "not available",
  "not published", "not specified", "not provided", "undefined", "-", "—",
]);

const cleanText = (value: string | null | undefined): string | undefined => {
  const text = (value ?? "").trim();
  if (!text || NULLISH_TEXT.has(text.toLowerCase())) return undefined;
  return text;
};

const cleanList = (values: string[] | null | undefined): string[] => [
  ...new Set(
    (values ?? [])
      .map((value) => cleanText(value))
      .filter((value): value is string => value !== undefined),
  ),
].slice(0, 12);

// =============================================================================
// Database surface
// =============================================================================

export const enrichmentTarget = internalQuery({
  args: { ccn: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      ccn: v.string(),
      name: v.string(),
      city: v.string(),
      state: v.string(),
      phone: v.string(),
      website: v.optional(v.string()),
      contactEmail: v.optional(v.string()),
      contactStatus: v.optional(v.string()),
      enrichedAt: v.optional(v.number()),
    }),
  ),
  handler: async (ctx, { ccn }) => {
    const f = await ctx.db
      .query("facilities")
      .withIndex("by_ccn", (q) => q.eq("ccn", ccn))
      .unique();
    if (!f) return null;
    return {
      ccn: f.ccn,
      name: f.name,
      city: f.city,
      state: f.state,
      phone: f.phone,
      website: f.website,
      contactEmail: f.contactEmail,
      contactStatus: f.contactStatus,
      enrichedAt: f.enrichedAt,
    };
  },
});

const contactStatusValidator = v.union(
  v.literal("pending"),
  v.literal("discovered"),
  v.literal("no_website_found"),
  v.literal("no_email_found"),
  v.literal("failed"),
);

export const saveDiscovery = internalMutation({
  args: {
    ccn: v.string(),
    contactStatus: contactStatusValidator,
    website: v.optional(v.string()),
    contactEmail: v.optional(v.string()),
    contactSourceUrl: v.optional(v.string()),
    enrichmentError: v.optional(v.string()),
    enrichment: v.optional(
      v.object({
        careLevels: v.array(v.string()),
        roomTypes: v.array(v.string()),
        amenities: v.array(v.string()),
        publishedPricing: v.optional(v.string()),
      }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const facility = await ctx.db
      .query("facilities")
      .withIndex("by_ccn", (q) => q.eq("ccn", args.ccn))
      .unique();
    if (!facility) return null;

    // Patch only what this run actually learned. A later failed run must not
    // erase an address an earlier successful run found.
    const patch: Record<string, unknown> = {
      contactStatus: args.contactStatus,
      enrichedAt: Date.now(),
      // Cleared on every run so a stale failure never sits under a fresh result.
      enrichmentError: args.enrichmentError,
    };
    if (args.website !== undefined) patch.website = args.website;
    if (args.contactEmail !== undefined) patch.contactEmail = args.contactEmail;
    if (args.contactSourceUrl !== undefined) {
      patch.contactSourceUrl = args.contactSourceUrl;
    }
    if (args.enrichment !== undefined) patch.enrichment = args.enrichment;

    await ctx.db.patch(facility._id, patch);
    return null;
  },
});

export const markPending = internalMutation({
  args: { ccn: v.string() },
  returns: v.null(),
  handler: async (ctx, { ccn }) => {
    const f = await ctx.db
      .query("facilities")
      .withIndex("by_ccn", (q) => q.eq("ccn", ccn))
      .unique();
    // `pending` is what makes the UI say "looking for a way to contact them"
    // instead of rendering an empty card.
    if (f) await ctx.db.patch(f._id, { contactStatus: "pending" });
    return null;
  },
});

// =============================================================================
// The pipeline
// =============================================================================

type SearchHit = { url: string; title?: string; description?: string };

/**
 * `search` returns either bare results or full documents depending on whether
 * scrapeOptions were passed, so normalise both into one shape.
 */
function normalizeHits(response: unknown): SearchHit[] {
  const out: SearchHit[] = [];
  const buckets = (response ?? {}) as Record<string, unknown>;
  for (const key of ["web", "news"]) {
    const list = buckets[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const row = item as Record<string, any>;
      const url: unknown = row.url ?? row.metadata?.sourceURL ?? row.metadata?.url;
      if (typeof url !== "string" || !url) continue;
      out.push({
        url,
        title:
          typeof row.title === "string"
            ? row.title
            : typeof row.metadata?.title === "string"
              ? row.metadata.title
              : undefined,
        description:
          typeof row.description === "string"
            ? row.description
            : typeof row.metadata?.description === "string"
              ? row.metadata.description
              : undefined,
      });
    }
  }
  return out;
}

export type EnrichmentResult = {
  ccn: string;
  status:
    | "discovered"
    | "no_website_found"
    | "no_email_found"
    | "failed"
    | "skipped_fresh"
    | "not_found";
  website?: string;
  contactEmail?: string;
  contactSourceUrl?: string;
  scrapesUsed: number;
  error?: string;
  errorCode?: string;
};

async function runEnrichment(
  ctx: ActionCtx,
  ccn: string,
  force: boolean,
  attempt: number,
): Promise<EnrichmentResult> {
  const target = await ctx.runQuery(internal.enrichment.enrichmentTarget, { ccn });
  if (!target) return { ccn, status: "not_found", scrapesUsed: 0 };

  const fresh =
    !force &&
    target.enrichedAt !== undefined &&
    Date.now() - target.enrichedAt < REDISCOVER_AFTER_MS &&
    target.contactStatus === "discovered";
  if (fresh) {
    return {
      ccn,
      status: "skipped_fresh",
      website: target.website,
      contactEmail: target.contactEmail,
      scrapesUsed: 0,
    };
  }

  await ctx.runMutation(internal.enrichment.markPending, { ccn });
  let scrapesUsed = 0;

  try {
    // --- 1. search() -------------------------------------------------------
    // CMS has no website field. This call is the only reason we have a domain
    // to work with at all; everything downstream depends on it.
    let siteOrigin = target.website ? originOf(target.website) : null;

    if (!siteOrigin) {
      const response = await firecrawl.search(
        ctx,
        siteSearchQuery({
          name: target.name,
          city: target.city,
          state: target.state,
        }),
        {
          sources: ["web"],
          limit: 8,
          // Filter the referral networks and directories out server-side.
          // Without this the eight slots fill with aggregators and the
          // facility's own site never appears in the results at all.
          excludeDomains: EXCLUDE_DOMAINS,
          timeout: 30_000,
        },
      );
      const hits = normalizeHits(response);
      const ranked = hits
        .map((hit, i) => ({
          hit,
          score: scoreCandidateSite({
            url: hit.url,
            title: hit.title,
            facilityName: target.name,
            city: target.city,
            position: i,
          }),
        }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score);

      siteOrigin = ranked.length > 0 ? originOf(ranked[0].hit.url) : null;
    }

    if (!siteOrigin) {
      // Not an error. A great many small homes simply have no website, and the
      // honest answer is the phone number CMS already gave us.
      await ctx.runMutation(internal.enrichment.saveDiscovery, {
        ccn,
        contactStatus: "no_website_found",
      });
      return { ccn, status: "no_website_found", scrapesUsed };
    }

    const siteHost = hostnameOf(siteOrigin)!;

    // --- 2. map() ----------------------------------------------------------
    // One call for the whole site, then rank the paths ourselves. Cheaper and
    // more predictable than guessing /contact and hoping.
    let candidates: string[] = [];
    try {
      const mapped = await firecrawl.map(ctx, siteOrigin, {
        limit: 150,
        includeSubdomains: false,
        timeout: 30_000,
      });
      candidates = rankContactPages(mapped.links ?? [], siteHost);
    } catch (error) {
      // A site that will not map may still scrape. Fall through to the
      // homepage rather than giving up on the facility.
      const failure = describeFirecrawlError(error);
      if (isFatalForBatch(failure)) throw error;
      console.warn(`map failed for ${siteHost}: ${failure.code}`);
    }
    if (candidates.length === 0) candidates = [siteOrigin];
    if (!candidates.includes(siteOrigin)) candidates.push(siteOrigin);

    // --- 3. scrape() -------------------------------------------------------
    // `links` gives us mailto: hrefs, which are the most trustworthy signal on
    // the page — a facility puts one there precisely so people write to it.
    // The json format is Firecrawl's structured extraction and fills in the
    // things no link can tell us: care levels, room types, pricing.
    let email: string | null = null;
    let sourceUrl: string | undefined;
    let enrichment:
      | {
          careLevels: string[];
          roomTypes: string[];
          amenities: string[];
          publishedPricing?: string;
        }
      | undefined;

    for (const url of candidates.slice(0, MAX_SCRAPES_PER_FACILITY)) {
      scrapesUsed++;
      const doc = await firecrawl.scrape(ctx, url, {
        formats: [
          "links",
          "markdown",
          {
            type: "json",
            prompt: EXTRACTION_PROMPT,
            schema: EXTRACTION_JSON_SCHEMA as unknown as Record<string, unknown>,
          },
        ],
        onlyMainContent: false, // footers are where addresses live
        maxAge: SCRAPE_MAX_AGE_MS,
        timeout: 30_000,
        blockAds: true,
      });

      const parsed = extractedSchema.safeParse(doc.json ?? {});
      const extracted = parsed.success ? parsed.data : null;

      if (extracted && enrichment === undefined) {
        const careLevels = cleanList(extracted.careLevels);
        const roomTypes = cleanList(extracted.roomTypes);
        const amenities = cleanList(extracted.amenities);
        const pricing = cleanText(extracted.publishedPricing);
        if (careLevels.length || roomTypes.length || amenities.length || pricing) {
          enrichment = { careLevels, roomTypes, amenities, publishedPricing: pricing };
        }
      }

      const extractedEmail = cleanText(extracted?.contactEmail);
      const candidatesFound = [
        ...(extractedEmail ? [extractedEmail] : []),
        ...harvestEmails({ links: doc.links, markdown: doc.markdown }),
      ];
      const best = pickBestEmail(candidatesFound, siteHost);
      if (best) {
        email = best;
        sourceUrl = doc.metadata?.sourceURL ?? url;
        break;
      }
    }

    if (!email) {
      // We found their website but no address on it. Keep the website — a
      // family can still click through — and say plainly that there is no
      // email to write to.
      await ctx.runMutation(internal.enrichment.saveDiscovery, {
        ccn,
        contactStatus: "no_email_found",
        website: siteOrigin,
        enrichment,
      });
      return { ccn, status: "no_email_found", website: siteOrigin, scrapesUsed };
    }

    await ctx.runMutation(internal.enrichment.saveDiscovery, {
      ccn,
      contactStatus: "discovered",
      website: siteOrigin,
      contactEmail: email,
      contactSourceUrl: sourceUrl,
      enrichment,
    });
    return {
      ccn,
      status: "discovered",
      website: siteOrigin,
      contactEmail: email,
      contactSourceUrl: sourceUrl,
      scrapesUsed,
    };
  } catch (error) {
    const failure: FirecrawlFailure = describeFirecrawlError(error);
    await ctx.runMutation(internal.enrichment.saveDiscovery, {
      ccn,
      contactStatus: "failed",
      enrichmentError: failure.message,
    });

    // A rate limit is a "later", not a "no". Retry once, on a delay, then stop
    // — a retry storm is how a 429 becomes a 402.
    if (failure.retryable && attempt < 1) {
      await ctx.scheduler.runAfter(
        failure.retryAfterMs ?? 60_000,
        internal.enrichment.enrichFacilityWorker,
        { ccn, force: true, attempt: attempt + 1 },
      );
    }
    return {
      ccn,
      status: "failed",
      scrapesUsed,
      error: failure.message,
      errorCode: failure.code,
    };
  }
}

const enrichmentResultValidator = v.object({
  ccn: v.string(),
  status: v.union(
    v.literal("discovered"),
    v.literal("no_website_found"),
    v.literal("no_email_found"),
    v.literal("failed"),
    v.literal("skipped_fresh"),
    v.literal("not_found"),
  ),
  website: v.optional(v.string()),
  contactEmail: v.optional(v.string()),
  contactSourceUrl: v.optional(v.string()),
  scrapesUsed: v.number(),
  error: v.optional(v.string()),
  errorCode: v.optional(v.string()),
});

/** Discovery for one facility. Called on view, the way translation is. */
export const enrichFacility = action({
  args: { ccn: v.string(), force: v.optional(v.boolean()) },
  returns: enrichmentResultValidator,
  handler: async (ctx, { ccn, force }): Promise<EnrichmentResult> =>
    await runEnrichment(ctx, ccn, force ?? false, 0),
});

/** The workpool and the scheduler both enter here. */
export const enrichFacilityWorker = internalAction({
  args: {
    ccn: v.string(),
    force: v.optional(v.boolean()),
    attempt: v.optional(v.number()),
  },
  returns: enrichmentResultValidator,
  handler: async (ctx, { ccn, force, attempt }): Promise<EnrichmentResult> =>
    await runEnrichment(ctx, ccn, force ?? false, attempt ?? 0),
});

/**
 * Fan discovery out across a shortlist through the bounded pool, so fifteen
 * facilities never become fifteen simultaneous Firecrawl requests.
 */
export const enrichBatch = mutation({
  args: { ccns: v.array(v.string()), force: v.optional(v.boolean()) },
  returns: v.object({ queued: v.number() }),
  handler: async (ctx, { ccns, force }) => {
    for (const ccn of [...new Set(ccns)]) {
      await enrichmentPool.enqueueAction(
        ctx,
        internal.enrichment.enrichFacilityWorker,
        { ccn, force: force ?? false, attempt: 0 },
      );
    }
    return { queued: new Set(ccns).size };
  },
});

// =============================================================================
// Read-time queries — reactive, so a card fills in while it is on screen
// =============================================================================

export const contactCard = query({
  args: { ccn: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      ccn: v.string(),
      name: v.string(),
      phone: v.string(), // always present — this is the CMS fallback
      website: v.union(v.string(), v.null()),
      contactEmail: v.union(v.string(), v.null()),
      contactSourceUrl: v.union(v.string(), v.null()),
      contactStatus: v.string(),
      enrichmentError: v.union(v.string(), v.null()),
      enrichedAt: v.union(v.number(), v.null()),
      enrichment: v.union(
        v.null(),
        v.object({
          careLevels: v.array(v.string()),
          roomTypes: v.array(v.string()),
          amenities: v.array(v.string()),
          publishedPricing: v.union(v.string(), v.null()),
        }),
      ),
    }),
  ),
  handler: async (ctx, { ccn }) => {
    const f = await ctx.db
      .query("facilities")
      .withIndex("by_ccn", (q) => q.eq("ccn", ccn))
      .unique();
    if (!f) return null;
    return {
      ccn: f.ccn,
      name: f.name,
      phone: f.phone,
      website: f.website ?? null,
      contactEmail: f.contactEmail ?? null,
      contactSourceUrl: f.contactSourceUrl ?? null,
      // "unstarted" is a real state the UI must render differently from a
      // failure: nothing has been attempted yet.
      contactStatus: f.contactStatus ?? "unstarted",
      enrichmentError: f.enrichmentError ?? null,
      enrichedAt: f.enrichedAt ?? null,
      enrichment: f.enrichment
        ? {
            careLevels: f.enrichment.careLevels,
            roomTypes: f.enrichment.roomTypes,
            amenities: f.enrichment.amenities,
            publishedPricing: f.enrichment.publishedPricing ?? null,
          }
        : null,
    };
  },
});

/**
 * The counter over a shortlist: how many facilities we can actually write to.
 *
 * Surfaced in the UI as-is, including the failures. A board that quietly showed
 * only the reachable facilities would be the same product as the one we are
 * arguing against.
 */
export const enrichmentStatus = query({
  args: { ccns: v.array(v.string()) },
  returns: v.object({
    total: v.number(),
    unstarted: v.number(),
    pending: v.number(),
    discovered: v.number(),
    noWebsite: v.number(),
    noEmail: v.number(),
    failed: v.number(),
    lastError: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, { ccns }) => {
    const counts = {
      total: 0,
      unstarted: 0,
      pending: 0,
      discovered: 0,
      noWebsite: 0,
      noEmail: 0,
      failed: 0,
      lastError: null as string | null,
    };
    for (const ccn of [...new Set(ccns)]) {
      const f = await ctx.db
        .query("facilities")
        .withIndex("by_ccn", (q) => q.eq("ccn", ccn))
        .unique();
      if (!f) continue;
      counts.total++;
      switch (f.contactStatus) {
        case "pending":
          counts.pending++;
          break;
        case "discovered":
          counts.discovered++;
          break;
        case "no_website_found":
          counts.noWebsite++;
          break;
        case "no_email_found":
          counts.noEmail++;
          break;
        case "failed":
          counts.failed++;
          if (f.enrichmentError) counts.lastError = f.enrichmentError;
          break;
        default:
          counts.unstarted++;
      }
    }
    return counts;
  },
});
