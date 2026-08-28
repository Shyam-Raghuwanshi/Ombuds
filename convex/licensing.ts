import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { FirecrawlClient } from "@firecrawl/firecrawl-convex";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";
import { components, internal } from "./_generated/api";
import { describeFirecrawlError } from "./lib/firecrawlErrors";
import {
  STATE_PORTALS,
  extractLicensedRows,
  type PortalKey,
} from "./lib/licensing";

/**
 * Durable Firecrawl crawls of state assisted-living licensing portals.
 *
 * CMS certifies nursing homes. Assisted living, adult homes, and enriched
 * housing are licensed by the STATES and appear nowhere in the federal data, so
 * for a family whose parent does not need skilled nursing the entire left-hand
 * side of our board is silent. This is the one place in the product where we
 * genuinely extend coverage past what the federal government knows.
 *
 * A crawl outlives any single action — it takes minutes and streams pages in
 * over time — which is exactly why it is a component: Firecrawl owns a crawl
 * row and a pages table inside Convex, advances them as pages land, and calls
 * an internal mutation of ours when it finishes. The UI subscribes to that row
 * with an ordinary `useQuery` and watches the count climb. No polling, no
 * refresh button.
 */

const firecrawl = new FirecrawlClient(components.firecrawl);

const portalKeys = v.union(v.literal("NY"), v.literal("CA"));

/**
 * Webhook when we have a secret to verify deliveries with, poll otherwise.
 *
 * A local deployment is not reachable from Firecrawl's servers, so poll mode is
 * what makes this work on a laptop — and the difference is invisible to the UI,
 * because either way progress arrives as writes to the same reactive row
 * (CLAUDE.md section 12, amber item 3).
 */
function defaultMode(): "webhook" | "poll" {
  return process.env.FIRECRAWL_WEBHOOK_SECRET ? "webhook" : "poll";
}

// =============================================================================
// Starting a crawl
// =============================================================================

export const recordCrawlStarted = internalMutation({
  args: {
    state: v.string(),
    portalName: v.string(),
    url: v.string(),
    crawlId: v.string(),
    jobId: v.optional(v.string()),
    mode: v.union(v.literal("webhook"), v.literal("poll")),
  },
  returns: v.id("licensingCrawls"),
  handler: async (ctx, args) =>
    await ctx.db.insert("licensingCrawls", {
      ...args,
      status: "scraping",
      pagesStored: 0,
      facilitiesExtracted: 0,
      pagesWithNoRows: 0,
      startedAt: Date.now(),
    }),
});

export const startStateCrawl = action({
  args: {
    state: portalKeys,
    mode: v.optional(v.union(v.literal("webhook"), v.literal("poll"))),
  },
  returns: v.object({
    ok: v.boolean(),
    crawlId: v.union(v.string(), v.null()),
    state: v.string(),
    portalName: v.string(),
    mode: v.string(),
    error: v.union(v.string(), v.null()),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    ok: boolean;
    crawlId: string | null;
    state: string;
    portalName: string;
    mode: string;
    error: string | null;
  }> => {
    const portal = STATE_PORTALS[args.state as PortalKey];
    const mode = args.mode ?? defaultMode();

    try {
      const { crawlId, jobId } = await firecrawl.startCrawl(ctx, {
        url: portal.url,
        mode,
        storeContent: true, // we parse the register out of the markdown
        options: {
          limit: portal.limit,
          includePaths: portal.includePaths,
          // Without this a crawl only follows links BENEATH its starting path.
          // The register we are after sits at /directory/acfs, a sibling of the
          // /acf/ section rather than a child of it, so the crawl has to be
          // allowed across the domain and fenced by includePaths instead.
          crawlEntireDomain: true,
          allowExternalLinks: false,
          allowSubdomains: false,
          maxConcurrency: 2, // a state health department is not a CDN
          scrapeOptions: {
            formats: ["markdown"],
            // The register lives in the page body, not the article well.
            onlyMainContent: false,
          },
        },
        // Runs exactly once when the crawl reaches a terminal state. The
        // context comes back untouched, which is how the callback knows which
        // state's parser to use.
        onComplete: internal.licensing.onCrawlComplete,
        context: { state: portal.state, portalKey: args.state },
      });

      await ctx.runMutation(internal.licensing.recordCrawlStarted, {
        state: portal.state,
        portalName: portal.portalName,
        url: portal.url,
        crawlId,
        jobId,
        mode,
      });

      return {
        ok: true,
        crawlId,
        state: portal.state,
        portalName: portal.portalName,
        mode,
        error: null,
      };
    } catch (error) {
      const failure = describeFirecrawlError(error);
      return {
        ok: false,
        crawlId: null,
        state: portal.state,
        portalName: portal.portalName,
        mode,
        error: failure.message,
      };
    }
  },
});

// =============================================================================
// Completion — the internal mutation Firecrawl calls back into
// =============================================================================

export const onCrawlComplete = internalMutation({
  args: {
    crawlId: v.string(),
    jobId: v.optional(v.string()),
    status: v.union(
      v.literal("completed"),
      v.literal("failed"),
      v.literal("cancelled"),
    ),
    pageCount: v.number(),
    unstored: v.optional(v.number()),
    error: v.optional(v.string()),
    context: v.optional(v.any()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("licensingCrawls")
      .withIndex("by_crawl", (q) => q.eq("crawlId", args.crawlId))
      .unique();
    if (!row) return null;

    await ctx.db.patch(row._id, {
      status: args.status,
      pagesStored: args.pageCount,
      completedAt: Date.now(),
      error:
        args.error ??
        (args.unstored
          ? `${args.unstored} page(s) were too large to store.`
          : undefined),
    });

    if (args.status !== "completed") return null;

    // Extraction is a read over every stored page, so it belongs in an action,
    // not in this transaction.
    await ctx.scheduler.runAfter(0, internal.licensing.extractCrawl, {
      crawlId: args.crawlId,
      portalKey: (args.context?.portalKey as PortalKey) ?? "NY",
    });
    return null;
  },
});

// =============================================================================
// Extraction
// =============================================================================

export const saveLicensedFacilities = internalMutation({
  args: {
    crawlId: v.string(),
    state: v.string(),
    careTypes: v.array(v.string()),
    sourceUrl: v.string(),
    rows: v.array(
      v.object({
        name: v.string(),
        address: v.string(),
        city: v.string(),
        zip: v.string(),
        phone: v.string(),
      }),
    ),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    let inserted = 0;
    for (const row of args.rows) {
      await ctx.db.insert("licensedFacilities", {
        state: args.state,
        name: row.name,
        address: row.address,
        city: row.city,
        zip: row.zip,
        phone: row.phone,
        careTypes: args.careTypes,
        sourceUrl: args.sourceUrl,
        crawlId: args.crawlId,
        foundAt: Date.now(),
      });
      inserted++;
    }
    return inserted;
  },
});

export const finishExtraction = internalMutation({
  args: {
    crawlId: v.string(),
    facilitiesExtracted: v.number(),
    pagesWithNoRows: v.number(),
    pagesStored: v.number(),
    note: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("licensingCrawls")
      .withIndex("by_crawl", (q) => q.eq("crawlId", args.crawlId))
      .unique();
    if (!row) return null;
    await ctx.db.patch(row._id, {
      facilitiesExtracted: args.facilitiesExtracted,
      pagesWithNoRows: args.pagesWithNoRows,
      pagesStored: args.pagesStored,
      error: args.note ?? row.error,
    });
    return null;
  },
});

export const clearExtraction = internalMutation({
  args: { state: v.string() },
  returns: v.number(),
  handler: async (ctx, { state }) => {
    // Cleared by STATE, not by crawl. A licensing register is a full snapshot
    // of what the state licenses today, so a fresh crawl replaces the previous
    // one rather than adding to it — the same reasoning that makes the monthly
    // CMS refresh replace a facility's citations instead of merging them. It
    // is also what stops a second demo run reporting twice as many facilities
    // as the state actually licenses.
    const existing = await ctx.db
      .query("licensedFacilities")
      .withIndex("by_state", (q) => q.eq("state", state))
      .collect();
    for (const doc of existing) await ctx.db.delete(doc._id);
    return existing.length;
  },
});

/**
 * Walk the pages the crawl stored and pull the register out of them.
 *
 * Most pages on a licensing portal are navigation, and they are counted as
 * such: `pagesWithNoRows` is reported in the UI rather than quietly averaged
 * away, because "we crawled 12 pages and one of them was the register" is the
 * honest description of what happened.
 */
export const extractCrawl = internalAction({
  args: { crawlId: v.string(), portalKey: portalKeys },
  returns: v.object({
    crawlId: v.string(),
    pages: v.number(),
    facilitiesExtracted: v.number(),
    pagesWithNoRows: v.number(),
    dropped: v.number(),
  }),
  handler: async (
    ctx,
    { crawlId, portalKey },
  ): Promise<{
    crawlId: string;
    pages: number;
    facilitiesExtracted: number;
    pagesWithNoRows: number;
    dropped: number;
  }> => {
    const portal = STATE_PORTALS[portalKey];
    await ctx.runMutation(internal.licensing.clearExtraction, {
      state: portal.state,
    });

    let cursor: string | null = null;
    let pages = 0;
    let extracted = 0;
    let pagesWithNoRows = 0;
    let dropped = 0;
    const seen = new Set<string>();

    for (;;) {
      // Small batches on purpose: a stored page can be most of a megabyte, and
      // this crosses a function boundary on every iteration.
      const page: {
        page: Array<{ url: string; markdown?: string }>;
        isDone: boolean;
        continueCursor: string;
      } = await ctx.runQuery(internal.licensing.crawlPageContent, {
        crawlId,
        paginationOpts: { numItems: 4, cursor },
      });

      for (const stored of page.page) {
        pages++;
        const outcome = extractLicensedRows(portal.extractor, stored.markdown);
        dropped += outcome.dropped;

        // The same facility can appear on more than one crawled page.
        const fresh = outcome.rows.filter((row) => {
          const key = `${row.name}|${row.zip}|${row.phone}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

        if (fresh.length === 0) {
          pagesWithNoRows++;
          continue;
        }
        extracted += await ctx.runMutation(
          internal.licensing.saveLicensedFacilities,
          {
            crawlId,
            state: portal.state,
            careTypes: portal.defaultCareTypes,
            sourceUrl: stored.url,
            rows: fresh,
          },
        );
      }

      if (page.isDone) break;
      cursor = page.continueCursor;
    }

    await ctx.runMutation(internal.licensing.finishExtraction, {
      crawlId,
      facilitiesExtracted: extracted,
      pagesWithNoRows,
      pagesStored: pages,
      note:
        dropped > 0
          ? `${dropped} record(s) on the state's pages could not be read cleanly and were left out.`
          : undefined,
    });

    return {
      crawlId,
      pages,
      facilitiesExtracted: extracted,
      pagesWithNoRows,
      dropped,
    };
  },
});

// =============================================================================
// Reactive reads — this is what the live progress bar subscribes to
// =============================================================================

/**
 * Page bodies, for the extractor.
 *
 * Component reads take a query context, so this cannot be called straight from
 * the action — which is the right shape anyway: reading is a query's job.
 */
export const crawlPageContent = internalQuery({
  args: { crawlId: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { crawlId, paginationOpts }) => {
    const page = await firecrawl.listPages(ctx, { crawlId, paginationOpts });
    return {
      ...page,
      page: page.page.map((p) => ({ url: p.url, markdown: p.markdown })),
    };
  },
});

export const appCrawl = internalQuery({
  args: { crawlId: v.string() },
  handler: async (ctx, { crawlId }) =>
    await ctx.db
      .query("licensingCrawls")
      .withIndex("by_crawl", (q) => q.eq("crawlId", crawlId))
      .unique(),
});

/**
 * Live crawl progress: our row joined to the component's own.
 *
 * Both halves update as the crawl runs, so a subscriber sees `completed` climb
 * toward `total` and `pageCount` climb behind it without asking again.
 */
export const crawlProgress = query({
  args: { crawlId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      crawlId: v.string(),
      state: v.string(),
      portalName: v.string(),
      url: v.string(),
      mode: v.string(),
      status: v.string(),
      /** Pages Firecrawl has attempted, as last reported. */
      total: v.union(v.number(), v.null()),
      /** Pages Firecrawl has finished, as last reported. */
      completed: v.union(v.number(), v.null()),
      /** Pages actually written into Convex. */
      pageCount: v.number(),
      creditsUsed: v.union(v.number(), v.null()),
      facilitiesExtracted: v.number(),
      pagesWithNoRows: v.number(),
      error: v.union(v.string(), v.null()),
      startedAt: v.number(),
      completedAt: v.union(v.number(), v.null()),
    }),
  ),
  handler: async (ctx, { crawlId }) => {
    const row = await ctx.db
      .query("licensingCrawls")
      .withIndex("by_crawl", (q) => q.eq("crawlId", crawlId))
      .unique();
    if (!row) return null;

    const live = await firecrawl.getCrawl(ctx, crawlId);
    return {
      crawlId,
      state: row.state,
      portalName: row.portalName,
      url: row.url,
      mode: row.mode,
      // The component's status is the fresher of the two while a crawl runs.
      status: live?.status ?? row.status,
      total: live?.total ?? null,
      completed: live?.completed ?? null,
      pageCount: live?.pageCount ?? row.pagesStored,
      creditsUsed: live?.creditsUsed ?? null,
      facilitiesExtracted: row.facilitiesExtracted,
      pagesWithNoRows: row.pagesWithNoRows,
      error: live?.error ?? row.error ?? null,
      startedAt: row.startedAt,
      completedAt: row.completedAt ?? null,
    };
  },
});

/** The newest crawl for a state, so the UI can pick up where it left off. */
export const latestCrawl = query({
  args: { state: portalKeys },
  returns: v.union(v.null(), v.object({ crawlId: v.string(), startedAt: v.number() })),
  handler: async (ctx, { state }) => {
    const row = await ctx.db
      .query("licensingCrawls")
      .withIndex("by_state", (q) => q.eq("state", state))
      .order("desc")
      .first();
    return row ? { crawlId: row.crawlId, startedAt: row.startedAt } : null;
  },
});

/** Pages as they land — pairs with `usePaginatedQuery`. */
export const crawlPages = query({
  args: { crawlId: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const page = await firecrawl.listPages(ctx, args);
    return {
      ...page,
      // Page bodies are large and the UI only lists URLs; sending the markdown
      // to the browser would be a megabyte per page for nothing.
      page: page.page.map((p) => ({
        _id: p._id,
        url: p.url,
        title: p.metadata?.title ?? null,
        statusCode: p.metadata?.statusCode ?? null,
        scrapedAt: p.scrapedAt,
        truncated: p.truncated,
      })),
    };
  },
});

/** What the crawl actually found, paginated. */
export const licensedFacilities = query({
  args: { state: portalKeys, paginationOpts: paginationOptsValidator },
  handler: async (ctx, { state, paginationOpts }) =>
    await ctx.db
      .query("licensedFacilities")
      .withIndex("by_state", (q) => q.eq("state", state))
      .order("desc")
      .paginate(paginationOpts),
});

/**
 * The headline number: facilities this state licenses that the federal
 * inspection data has no record of.
 *
 * Note what is deliberately NOT reported here — a count of the CMS-certified
 * nursing homes we happen to hold for the same state. That number reflects how
 * many facilities we have ingested, not how many exist, so putting it beside
 * the licensed count would read as a comparison while measuring nothing. The
 * honest claim is the single one: this state licenses these facilities, and
 * none of them have a federal inspection record.
 */
export const stateCoverage = query({
  args: { state: portalKeys },
  returns: v.object({
    state: v.string(),
    portalName: v.string(),
    description: v.string(),
    url: v.string(),
    licensedCount: v.number(),
    /** Where the register itself was read from — provenance, per screen. */
    registerUrl: v.union(v.string(), v.null()),
    pagesCrawled: v.number(),
    crawledAt: v.union(v.number(), v.null()),
    sample: v.array(
      v.object({
        name: v.string(),
        address: v.string(),
        city: v.string(),
        zip: v.string(),
        phone: v.string(),
        careTypes: v.array(v.string()),
        sourceUrl: v.string(),
      }),
    ),
  }),
  handler: async (ctx, { state }) => {
    const portal = STATE_PORTALS[state as PortalKey];
    const licensed = await ctx.db
      .query("licensedFacilities")
      .withIndex("by_state", (q) => q.eq("state", state))
      .collect();
    const crawl = await ctx.db
      .query("licensingCrawls")
      .withIndex("by_state", (q) => q.eq("state", state))
      .order("desc")
      .first();

    return {
      state,
      portalName: portal.portalName,
      description: portal.description,
      url: portal.url,
      licensedCount: licensed.length,
      registerUrl: licensed[0]?.sourceUrl ?? null,
      pagesCrawled: crawl?.pagesStored ?? 0,
      crawledAt: crawl?.completedAt ?? null,
      sample: licensed.slice(0, 6).map((f) => ({
        name: f.name,
        address: f.address,
        city: f.city,
        zip: f.zip,
        phone: f.phone,
        careTypes: f.careTypes,
        sourceUrl: f.sourceUrl,
      })),
    };
  },
});
