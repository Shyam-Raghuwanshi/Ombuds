import { v } from "convex/values";
import { FirecrawlClient } from "@firecrawl/firecrawl-convex";
import { action, internalMutation, internalQuery, query } from "./_generated/server";
import { components, internal } from "./_generated/api";
import { generateStructured } from "./ai/provider";
import {
  FACILITY_NEWS_SYSTEM,
  newsTriageSchema,
  type NewsTriage,
} from "./ai/schemas";
import { describeFirecrawlError } from "./lib/firecrawlErrors";
import { EXCLUDE_DOMAINS, hostnameOf } from "./lib/contact";

/**
 * Local news, found with Firecrawl search.
 *
 * The federal record is authoritative and slow. A state survey is written up,
 * disputed, and finally published to CMS months after the inspector walked out
 * — our own facility rows carry survey dates from a year or more ago. The
 * county paper runs the lawsuit the week it is filed.
 *
 * So this is not a "more data" feature. It is a recency feature, and the UI
 * says so: local reporting sits in its own section, dated and attributed to the
 * outlet, and is never mixed in with the federal inspection record.
 *
 * Two safeguards, because publishing this about a real business matters:
 *   1. A story the model is not confident is about THIS facility is dropped,
 *      not downgraded. Chains share one brand across dozens of buildings.
 *   2. Nothing is ever restated as fact. The model attributes every claim to
 *      the outlet, and we show the link so a reader can go and check.
 */

const firecrawl = new FirecrawlClient(components.firecrawl);

/** Rescan at most weekly. Local news does not break hourly. */
const RESCAN_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

const concernLevelValidator = v.union(
  v.literal("informational"),
  v.literal("concerning"),
  v.literal("serious"),
);

/**
 * Aimed at the things CMS is too slow to carry. `tbs: "qdr:y"` limits results
 * to the past year, which is roughly where the federal record stops being
 * current.
 *
 * The name is deliberately unquoted. A quoted phrase search for a facility name
 * plus these keywords returns nothing at all — the exact phrase and the words
 * "lawsuit" and "citation" rarely co-occur on one indexed page even when the
 * story exists. Unquoted, the search returns candidates and the triage step
 * decides which of them are real, which is the correct division of labour: the
 * search casts wide, the model rules out.
 */
function newsQuery(args: { name: string; city: string; state: string }): string {
  return `${args.name} ${args.city} ${args.state} nursing home lawsuit investigation citation`;
}

/**
 * Noise the search reliably returns and the model would only have to reject:
 * injury-lawyer marketing pages built to rank for exactly this query, social
 * media, and the directory sites we already exclude elsewhere.
 */
const NEWS_EXCLUDE_DOMAINS = [
  ...EXCLUDE_DOMAINS,
  "nursinghomeabusecenter.com",
  "lanzonemorgan.com",
  "nursinghomeabuseguide.org",
  "nursinghomelawcenter.org",
  "justia.com",
  "avvo.com",
  "findlaw.com",
  "miradorliving.com",
  "reddit.com",
  "pinterest.com",
  "tiktok.com",
];

export const newsScanTarget = internalQuery({
  args: { ccn: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      ccn: v.string(),
      name: v.string(),
      city: v.string(),
      state: v.string(),
      address: v.string(),
      newsScannedAt: v.union(v.number(), v.null()),
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
      address: f.address,
      newsScannedAt: f.newsScannedAt ?? null,
    };
  },
});

export const saveNews = internalMutation({
  args: {
    ccn: v.string(),
    items: v.array(
      v.object({
        title: v.string(),
        url: v.string(),
        outlet: v.string(),
        snippet: v.string(),
        publishedAt: v.number(),
        concernLevel: concernLevelValidator,
        whyItMatters: v.string(),
        model: v.string(),
      }),
    ),
  },
  returns: v.number(),
  handler: async (ctx, { ccn, items }) => {
    let inserted = 0;
    for (const item of items) {
      // The same story resurfaces on every rescan; the (ccn, url) index is the
      // dedupe key. Patch rather than skip so a re-judged concern level wins.
      const existing = await ctx.db
        .query("facilityNews")
        .withIndex("by_ccn_url", (q) => q.eq("ccn", ccn).eq("url", item.url))
        .unique();
      if (existing) {
        await ctx.db.patch(existing._id, {
          concernLevel: item.concernLevel,
          whyItMatters: item.whyItMatters,
          model: item.model,
        });
        continue;
      }
      await ctx.db.insert("facilityNews", { ccn, ...item, foundAt: Date.now() });
      inserted++;
    }

    // Stamped even when nothing was found, so "we looked and there was nothing"
    // is distinguishable from "we never looked". The UI says which.
    const facility = await ctx.db
      .query("facilities")
      .withIndex("by_ccn", (q) => q.eq("ccn", ccn))
      .unique();
    if (facility) await ctx.db.patch(facility._id, { newsScannedAt: Date.now() });
    return inserted;
  },
});

type Hit = { url: string; title: string; snippet: string };

function normalizeNewsHits(response: unknown): Hit[] {
  const out: Hit[] = [];
  const buckets = (response ?? {}) as Record<string, unknown>;
  for (const key of ["news", "web"]) {
    const list = buckets[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const row = item as Record<string, any>;
      const url: unknown = row.url ?? row.metadata?.sourceURL;
      if (typeof url !== "string" || !url) continue;
      if (out.some((h) => h.url === url)) continue;
      out.push({
        url,
        title: String(row.title ?? row.metadata?.title ?? "").trim(),
        snippet: String(
          row.description ?? row.snippet ?? row.metadata?.description ?? "",
        ).trim(),
      });
    }
  }
  return out.filter((h) => h.title || h.snippet);
}

/** A year is enough to date a story; the exact day is rarely in a snippet. */
function yearToTimestamp(year: number | null): number {
  if (year === null || year < 1990 || year > 2100) return 0;
  return Date.parse(`${year}-01-01T00:00:00Z`);
}

export const scanFacilityNews = action({
  args: { ccn: v.string(), force: v.optional(v.boolean()) },
  returns: v.object({
    ccn: v.string(),
    searched: v.number(),
    kept: v.number(),
    inserted: v.number(),
    skipped: v.boolean(),
    error: v.union(v.string(), v.null()),
  }),
  handler: async (
    ctx,
    { ccn, force },
  ): Promise<{
    ccn: string;
    searched: number;
    kept: number;
    inserted: number;
    skipped: boolean;
    error: string | null;
  }> => {
    const target = await ctx.runQuery(internal.news.newsScanTarget, { ccn });
    if (!target) {
      return { ccn, searched: 0, kept: 0, inserted: 0, skipped: true, error: null };
    }
    if (
      !force &&
      target.newsScannedAt !== null &&
      Date.now() - target.newsScannedAt < RESCAN_AFTER_MS
    ) {
      return { ccn, searched: 0, kept: 0, inserted: 0, skipped: true, error: null };
    }

    let hits: Hit[];
    try {
      const response = await firecrawl.search(ctx, newsQuery(target), {
        sources: ["news", "web"],
        limit: 10,
        tbs: "qdr:y", // the past year — CMS already covers what is older
        excludeDomains: NEWS_EXCLUDE_DOMAINS,
        timeout: 30_000,
      });
      hits = normalizeNewsHits(response);
    } catch (error) {
      // The federal record on this page is unaffected, and the message says so.
      const failure = describeFirecrawlError(error);
      return {
        ccn,
        searched: 0,
        kept: 0,
        inserted: 0,
        skipped: false,
        error: failure.message,
      };
    }

    if (hits.length === 0) {
      await ctx.runMutation(internal.news.saveNews, { ccn, items: [] });
      return { ccn, searched: 0, kept: 0, inserted: 0, skipped: false, error: null };
    }

    // One model call for the whole result set rather than one per story: it is
    // cheaper, and it lets the model compare results against each other when
    // deciding which of two similarly-named homes a story is about.
    const prompt = [
      `The facility is: ${target.name}`,
      `Address: ${target.address}, ${target.city}, ${target.state}`,
      ``,
      `Search results to judge:`,
      ...hits.map((h, i) =>
        [
          `[${i}] ${h.title}`,
          `    source: ${hostnameOf(h.url) ?? h.url}`,
          `    snippet: ${h.snippet || "(no snippet)"}`,
        ].join("\n"),
      ),
      ``,
      `Return exactly ${hits.length} items, one for each index above.`,
    ].join("\n");

    // If the triage step cannot run, nothing is stored. Showing untriaged search
    // results would mean putting another facility's lawsuit on this facility's
    // page, which is the one failure this whole section is built to avoid.
    let object: NewsTriage;
    let model: string;
    try {
      const result = await generateStructured({
        task: "facilityNewsScan",
        system: FACILITY_NEWS_SYSTEM,
        prompt,
        schema: newsTriageSchema,
        schemaName: "facility_news_triage",
        schemaDescription:
          "Which local news results are genuinely about this one facility, and how serious each is.",
      });
      object = result.object;
      model = result.model;
    } catch (error) {
      console.error("news triage failed", error);
      return {
        ccn,
        searched: hits.length,
        kept: 0,
        inserted: 0,
        skipped: false,
        error:
          "We found local coverage but could not review it yet, so we are not " +
          "showing it. Only stories we have confirmed are about this exact " +
          "facility are ever published here.",
      };
    }

    const kept = object.items
      .filter(
        (item) =>
          item.isAboutThisFacility &&
          item.index >= 0 &&
          item.index < hits.length,
      )
      .map((item) => {
        const hit = hits[item.index];
        return {
          title: hit.title || hit.url,
          url: hit.url,
          outlet: hostnameOf(hit.url) ?? "unknown source",
          snippet: hit.snippet,
          publishedAt: yearToTimestamp(item.publishedYear),
          concernLevel: item.concernLevel,
          whyItMatters: item.whyItMatters.trim(),
          model,
        };
      });

    const inserted = await ctx.runMutation(internal.news.saveNews, {
      ccn,
      items: kept,
    });
    return {
      ccn,
      searched: hits.length,
      kept: kept.length,
      inserted,
      skipped: false,
      error: null,
    };
  },
});

/**
 * Reactive read. `scanned` is deliberately separate from an empty list: "we
 * searched the local press and found nothing" is a real, reassuring answer, and
 * "we have not looked yet" must not be shown as if it were that answer.
 */
export const facilityNews = query({
  args: { ccn: v.string() },
  returns: v.object({
    scanned: v.boolean(),
    scannedAt: v.union(v.number(), v.null()),
    items: v.array(
      v.object({
        _id: v.id("facilityNews"),
        title: v.string(),
        url: v.string(),
        outlet: v.string(),
        snippet: v.string(),
        publishedAt: v.number(),
        concernLevel: v.string(),
        whyItMatters: v.string(),
        model: v.string(),
        foundAt: v.number(),
      }),
    ),
  }),
  handler: async (ctx, { ccn }) => {
    const facility = await ctx.db
      .query("facilities")
      .withIndex("by_ccn", (q) => q.eq("ccn", ccn))
      .unique();
    const rows = await ctx.db
      .query("facilityNews")
      .withIndex("by_ccn", (q) => q.eq("ccn", ccn))
      .collect();

    const rank: Record<string, number> = {
      serious: 2,
      concerning: 1,
      informational: 0,
    };
    rows.sort(
      (a, b) =>
        rank[b.concernLevel] - rank[a.concernLevel] ||
        b.publishedAt - a.publishedAt,
    );

    return {
      scanned: facility?.newsScannedAt !== undefined,
      scannedAt: facility?.newsScannedAt ?? null,
      items: rows.map((r) => ({
        _id: r._id,
        title: r.title,
        url: r.url,
        outlet: r.outlet,
        snippet: r.snippet,
        publishedAt: r.publishedAt,
        concernLevel: r.concernLevel,
        whyItMatters: r.whyItMatters,
        model: r.model,
        foundAt: r.foundAt,
      })),
    };
  },
});
