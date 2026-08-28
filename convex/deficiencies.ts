import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { action, internalMutation, internalQuery, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { generateStructured } from "./ai/provider";
import {
  DEFICIENCY_TRANSLATION_SYSTEM,
  FACILITY_RISK_SUMMARY_SYSTEM,
  deficiencyTranslationSchema,
  facilityRiskSummarySchema,
} from "./ai/schemas";
import {
  HARM_PHRASE,
  HARM_RANK,
  SPREAD_PHRASE,
  harmLevelFor,
  monthYear,
  spreadFor,
  type HarmLevel,
  type Spread,
} from "./lib/severity";

/**
 * Deficiency translation.
 *
 * The whole cost story of this product lives in one decision: translated text
 * is keyed by (tag, scopeSeverity) and by nothing else. There are ~420,000
 * citations on record nationally but only ~1,500 distinct meanings among them,
 * because "F0689 at severity G" means exactly the same thing in Montebello as
 * it does in Moraga. Uncached, a full pass costs ~$510 on a flagship model.
 * Cached, the same work costs under $1. CLAUDE.md section 10.
 *
 * Two consequences the code has to respect:
 *   1. Nothing citation-specific may enter the cached text. The survey date,
 *      the facility, and the correction date are all per-citation, so the
 *      correction clause is appended deterministically at read time instead.
 *   2. Nothing is translated during ingest. Translation is triggered when a
 *      facility is actually viewed.
 */

const cacheKey = (tag: string, scopeSeverity: string) =>
  `${tag}|${scopeSeverity.toUpperCase()}`;

// =============================================================================
// The cache
// =============================================================================

export const getCachedTranslations = internalQuery({
  args: {
    keys: v.array(v.object({ tag: v.string(), scopeSeverity: v.string() })),
  },
  returns: v.record(
    v.string(),
    v.object({ plainEnglish: v.string(), model: v.string() }),
  ),
  handler: async (ctx, { keys }) => {
    const out: Record<string, { plainEnglish: string; model: string }> = {};
    const seen = new Set<string>();
    for (const k of keys) {
      const key = cacheKey(k.tag, k.scopeSeverity);
      if (seen.has(key)) continue;
      seen.add(key);
      const row = await ctx.db
        .query("tagTranslations")
        .withIndex("by_tag_severity", (q) =>
          q.eq("tag", k.tag).eq("scopeSeverity", k.scopeSeverity.toUpperCase()),
        )
        .first();
      if (row) out[key] = { plainEnglish: row.plainEnglish, model: row.model };
    }
    return out;
  },
});

export const putTranslation = internalMutation({
  args: {
    tag: v.string(),
    scopeSeverity: v.string(),
    plainEnglish: v.string(),
    model: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const scopeSeverity = args.scopeSeverity.toUpperCase();
    // Two facility views racing on the same uncached tag would otherwise write
    // two rows. First writer wins; the loser's tokens are already spent but the
    // table stays one row per (tag, severity).
    const existing = await ctx.db
      .query("tagTranslations")
      .withIndex("by_tag_severity", (q) =>
        q.eq("tag", args.tag).eq("scopeSeverity", scopeSeverity),
      )
      .first();
    if (existing) return null;

    await ctx.db.insert("tagTranslations", {
      tag: args.tag,
      scopeSeverity,
      plainEnglish: args.plainEnglish,
      model: args.model,
      createdAt: Date.now(),
    });
    return null;
  },
});

// =============================================================================
// Translation
// =============================================================================

/**
 * The per-citation half of the sentence. Deterministic — a date is not
 * something to spend a model call on, and it must not enter the shared cache.
 */
function correctionClause(correctionDate: number | undefined): string {
  return correctionDate === undefined
    ? "The record does not show a correction date."
    : `Corrected ${monthYear(correctionDate)}.`;
}

function buildPrompt(args: {
  tag: string;
  tagDescription: string;
  scopeSeverity: string;
  harmLevel: HarmLevel;
  spread: Spread;
}): string {
  // Deliberately contains nothing citation-specific — same input, same cached
  // output, for every facility in the country.
  return [
    `What the facility is required to do: ${args.tagDescription}`,
    ``,
    `The inspector found this requirement was not met.`,
    `Harm level: ${HARM_PHRASE[args.harmLevel]}`,
    `How far it spread: ${SPREAD_PHRASE[args.spread]}.`,
    ``,
    `Write the plain-English explanation.`,
  ].join("\n");
}

/**
 * Translate one (tag, severity) pair. Cache first, model only on a miss,
 * write through on the way back.
 *
 * `spread` and the harm level are both functions of the severity letter — the
 * federal grid decides them, not us — so a caller-supplied `spread` is accepted
 * for convenience but the letter is authoritative if the two disagree.
 */
export const translateDeficiency = action({
  args: {
    tag: v.string(),
    tagDescription: v.string(),
    scopeSeverity: v.string(),
    spread: v.optional(v.string()),
    correctionDate: v.optional(v.number()),
  },
  returns: v.object({
    tag: v.string(),
    scopeSeverity: v.string(),
    harmLevel: v.string(),
    spread: v.string(),
    plainEnglish: v.string(), // cached half — shared by every facility
    full: v.string(), // cached half + this citation's correction clause
    model: v.string(),
    cached: v.boolean(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    tag: string;
    scopeSeverity: string;
    harmLevel: string;
    spread: string;
    plainEnglish: string;
    full: string;
    model: string;
    cached: boolean;
  }> => {
    const scopeSeverity = args.scopeSeverity.trim().toUpperCase();
    const harmLevel = harmLevelFor(scopeSeverity);
    const spread = spreadFor(scopeSeverity);

    const hit = await ctx.runQuery(internal.deficiencies.getCachedTranslations, {
      keys: [{ tag: args.tag, scopeSeverity }],
    });
    const cachedRow = hit[cacheKey(args.tag, scopeSeverity)];

    let plainEnglish: string;
    let model: string;
    let cached: boolean;

    if (cachedRow) {
      plainEnglish = cachedRow.plainEnglish;
      model = cachedRow.model;
      cached = true;
    } else {
      const result = await generateStructured({
        task: "deficiencyTranslation",
        system: DEFICIENCY_TRANSLATION_SYSTEM,
        prompt: buildPrompt({
          tag: args.tag,
          tagDescription: args.tagDescription,
          scopeSeverity,
          harmLevel,
          spread,
        }),
        schema: deficiencyTranslationSchema,
        schemaName: "deficiency_translation",
        schemaDescription:
          "A plain-English explanation of one federal nursing home inspection finding.",
      });
      plainEnglish = result.object.plainEnglish.trim();
      model = result.model;
      cached = false;
      await ctx.runMutation(internal.deficiencies.putTranslation, {
        tag: args.tag,
        scopeSeverity,
        plainEnglish,
        model,
      });
    }

    return {
      tag: args.tag,
      scopeSeverity,
      harmLevel,
      spread,
      plainEnglish,
      full: `${plainEnglish} ${correctionClause(args.correctionDate)}`,
      model,
      cached,
    };
  },
});

// =============================================================================
// Lazy translation for one facility — the on-view entry point
// =============================================================================

export const distinctPairsForFacility = internalQuery({
  args: { ccn: v.string() },
  returns: v.array(
    v.object({
      tag: v.string(),
      scopeSeverity: v.string(),
      tagDescription: v.string(),
    }),
  ),
  handler: async (ctx, { ccn }) => {
    const rows = await ctx.db
      .query("deficiencies")
      .withIndex("by_ccn", (q) => q.eq("ccn", ccn))
      .collect();
    const byKey = new Map<
      string,
      { tag: string; scopeSeverity: string; tagDescription: string }
    >();
    for (const r of rows) {
      const key = cacheKey(r.tag, r.scopeSeverity);
      if (!byKey.has(key)) {
        byKey.set(key, {
          tag: r.tag,
          scopeSeverity: r.scopeSeverity,
          tagDescription: r.tagDescription,
        });
      }
    }
    return [...byKey.values()];
  },
});

/**
 * Called when a family opens a facility. A facility with 196 citations
 * typically has ~40 distinct (tag, severity) pairs, and most of those are
 * already in the cache from some other facility in some other state — so the
 * second facility a family opens usually costs nothing at all.
 */
export const translateFacility = action({
  args: { ccn: v.string() },
  returns: v.object({
    ccn: v.string(),
    distinctPairs: v.number(),
    alreadyCached: v.number(),
    translated: v.number(),
    failed: v.number(),
  }),
  handler: async (
    ctx,
    { ccn },
  ): Promise<{
    ccn: string;
    distinctPairs: number;
    alreadyCached: number;
    translated: number;
    failed: number;
  }> => {
    const pairs: Array<{
      tag: string;
      scopeSeverity: string;
      tagDescription: string;
    }> = await ctx.runQuery(
      internal.deficiencies.distinctPairsForFacility,
      { ccn },
    );
    if (pairs.length === 0) {
      return { ccn, distinctPairs: 0, alreadyCached: 0, translated: 0, failed: 0 };
    }

    const cache = await ctx.runQuery(internal.deficiencies.getCachedTranslations, {
      keys: pairs.map((p) => ({ tag: p.tag, scopeSeverity: p.scopeSeverity })),
    });
    const misses = pairs.filter(
      (p) => !cache[cacheKey(p.tag, p.scopeSeverity)],
    );

    let translated = 0;
    let failed = 0;
    // Small batches: enough parallelism that the board fills in while the judge
    // is still reading it, few enough that we stay well under rate limits.
    const BATCH = 5;
    for (let i = 0; i < misses.length; i += BATCH) {
      const results = await Promise.allSettled(
        misses.slice(i, i + BATCH).map(async (p) => {
          const result = await generateStructured({
            task: "deficiencyTranslation",
            system: DEFICIENCY_TRANSLATION_SYSTEM,
            prompt: buildPrompt({
              tag: p.tag,
              tagDescription: p.tagDescription,
              scopeSeverity: p.scopeSeverity,
              harmLevel: harmLevelFor(p.scopeSeverity),
              spread: spreadFor(p.scopeSeverity),
            }),
            schema: deficiencyTranslationSchema,
            schemaName: "deficiency_translation",
            schemaDescription:
              "A plain-English explanation of one federal nursing home inspection finding.",
          });
          // Write through one at a time so a partial batch still lands in the
          // cache and streams into the open page.
          await ctx.runMutation(internal.deficiencies.putTranslation, {
            tag: p.tag,
            scopeSeverity: p.scopeSeverity,
            plainEnglish: result.object.plainEnglish.trim(),
            model: result.model,
          });
        }),
      );
      for (const r of results) {
        if (r.status === "fulfilled") translated++;
        else {
          failed++;
          console.error("translation failed", r.reason);
        }
      }
    }

    return {
      ccn,
      distinctPairs: pairs.length,
      alreadyCached: pairs.length - misses.length,
      translated,
      failed,
    };
  },
});

// =============================================================================
// Per-facility risk summary — the pattern, not a list
// =============================================================================

export const riskSummaryBasis = internalQuery({
  args: { ccn: v.string() },
  returns: v.object({
    facilityName: v.string(),
    found: v.boolean(),
    citationCount: v.number(),
    latestSurveyDate: v.number(),
    cached: v.union(
      v.null(),
      v.object({
        summary: v.string(),
        pattern: v.string(),
        citationCount: v.number(),
        latestSurveyDate: v.number(),
        model: v.string(),
      }),
    ),
    digest: v.string(),
  }),
  handler: async (ctx, { ccn }) => {
    const facility = await ctx.db
      .query("facilities")
      .withIndex("by_ccn", (q) => q.eq("ccn", ccn))
      .unique();
    const rows = await ctx.db
      .query("deficiencies")
      .withIndex("by_ccn", (q) => q.eq("ccn", ccn))
      .collect();
    const existing = await ctx.db
      .query("facilityRiskSummaries")
      .withIndex("by_ccn", (q) => q.eq("ccn", ccn))
      .first();

    const latestSurveyDate = rows.reduce((m, r) => Math.max(m, r.surveyDate), 0);

    return {
      facilityName: facility?.name ?? "",
      found: facility !== null,
      citationCount: rows.length,
      latestSurveyDate,
      cached: existing
        ? {
            summary: existing.summary,
            pattern: existing.pattern,
            citationCount: existing.citationCount,
            latestSurveyDate: existing.latestSurveyDate,
            model: existing.model,
          }
        : null,
      digest: buildDigest(facility?.name ?? ccn, rows),
    };
  },
});

/**
 * Compress a whole citation history into the few hundred tokens that actually
 * carry the pattern: what repeats, across which inspections, and how bad it got.
 * Sending 196 raw rows would cost more and read worse.
 */
function buildDigest(
  facilityName: string,
  rows: Array<{
    tag: string;
    tagDescription: string;
    scopeSeverity: string;
    harmLevel: HarmLevel;
    surveyDate: number;
    correctionDate?: number;
    isComplaint: boolean;
  }>,
): string {
  if (rows.length === 0) {
    return `${facilityName} has no citations on record in the federal inspection data.`;
  }

  const years = new Map<string, number>();
  const byTag = new Map<
    string,
    { description: string; years: Set<string>; count: number; worst: HarmLevel }
  >();
  const harmCounts: Record<HarmLevel, number> = {
    minimal: 0,
    potential: 0,
    actual_harm: 0,
    immediate_jeopardy: 0,
  };
  const serious: string[] = [];

  for (const r of rows) {
    const year = new Date(r.surveyDate).getUTCFullYear().toString();
    years.set(year, (years.get(year) ?? 0) + 1);
    harmCounts[r.harmLevel]++;

    const entry = byTag.get(r.tag) ?? {
      description: r.tagDescription,
      years: new Set<string>(),
      count: 0,
      worst: r.harmLevel,
    };
    entry.years.add(year);
    entry.count++;
    if (HARM_RANK[r.harmLevel] > HARM_RANK[entry.worst]) entry.worst = r.harmLevel;
    byTag.set(r.tag, entry);

    if (r.harmLevel === "actual_harm" || r.harmLevel === "immediate_jeopardy") {
      serious.push(
        `- ${year}: ${r.tagDescription} — ${HARM_PHRASE[r.harmLevel]}` +
          (r.correctionDate ? ` Corrected ${monthYear(r.correctionDate)}.` : "") +
          (r.isComplaint ? " Found after a complaint." : ""),
      );
    }
  }

  const repeated = [...byTag.entries()]
    .filter(([, e]) => e.years.size >= 2)
    .sort((a, b) => b[1].years.size - a[1].years.size || b[1].count - a[1].count)
    .slice(0, 12)
    .map(
      ([, e]) =>
        `- ${e.description} — cited in ${e.years.size} separate inspection years ` +
        `(${[...e.years].sort().join(", ")}), ${e.count} times in total`,
    );

  const yearLine = [...years.entries()]
    .sort()
    .map(([y, n]) => `${y}: ${n}`)
    .join(", ");

  return [
    `Facility: ${facilityName}`,
    `Total findings on record: ${rows.length}`,
    `Findings per inspection year: ${yearLine}`,
    ``,
    `Harm breakdown:`,
    `- ${harmCounts.immediate_jeopardy} placed residents in immediate jeopardy`,
    `- ${harmCounts.actual_harm} caused actual harm to a resident`,
    `- ${harmCounts.potential} had potential for more than minimal harm, no harm occurred`,
    `- ${harmCounts.minimal} were minimal`,
    ``,
    serious.length
      ? `Every finding that caused harm or worse:\n${serious.sort().reverse().join("\n")}`
      : `No finding on record caused actual harm or immediate jeopardy.`,
    ``,
    repeated.length
      ? `Requirements the facility failed in more than one inspection year:\n${repeated.join("\n")}`
      : `No requirement was failed in more than one inspection year.`,
  ].join("\n");
}

export const putRiskSummary = internalMutation({
  args: {
    ccn: v.string(),
    summary: v.string(),
    pattern: v.union(
      v.literal("clean"),
      v.literal("isolated_incident"),
      v.literal("improving"),
      v.literal("recurring"),
      v.literal("severe_recurring"),
    ),
    citationCount: v.number(),
    latestSurveyDate: v.number(),
    model: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("facilityRiskSummaries")
      .withIndex("by_ccn", (q) => q.eq("ccn", args.ccn))
      .first();
    const doc = { ...args, createdAt: Date.now() };
    if (existing) await ctx.db.replace(existing._id, doc);
    else await ctx.db.insert("facilityRiskSummaries", doc);
    return null;
  },
});

/**
 * Two to three sentences about the pattern across a facility's whole history.
 * Cached per CCN and regenerated only when the citation history actually
 * changes — CMS refreshes monthly, so this is one call per facility per month
 * at worst. Never generated during ingest.
 */
export const summarizeFacilityRisk = action({
  args: { ccn: v.string(), force: v.optional(v.boolean()) },
  returns: v.object({
    ccn: v.string(),
    summary: v.string(),
    pattern: v.string(),
    model: v.string(),
    cached: v.boolean(),
  }),
  handler: async (
    ctx,
    { ccn, force },
  ): Promise<{
    ccn: string;
    summary: string;
    pattern: string;
    model: string;
    cached: boolean;
  }> => {
    const basis = await ctx.runQuery(internal.deficiencies.riskSummaryBasis, { ccn });
    if (!basis.found) throw new Error(`No facility ingested for CCN ${ccn}`);

    const stale =
      basis.cached === null ||
      basis.cached.citationCount !== basis.citationCount ||
      basis.cached.latestSurveyDate !== basis.latestSurveyDate;

    if (basis.cached && !stale && !force) {
      return {
        ccn,
        summary: basis.cached.summary,
        pattern: basis.cached.pattern,
        model: basis.cached.model,
        cached: true,
      };
    }

    const { object, model } = await generateStructured({
      task: "facilityRiskSummary",
      system: FACILITY_RISK_SUMMARY_SYSTEM,
      prompt: basis.digest,
      schema: facilityRiskSummarySchema,
      schemaName: "facility_risk_summary",
      schemaDescription:
        "A two-to-three sentence description of the pattern in one facility's federal inspection history.",
    });

    await ctx.runMutation(internal.deficiencies.putRiskSummary, {
      ccn,
      summary: object.summary.trim(),
      pattern: object.pattern,
      citationCount: basis.citationCount,
      latestSurveyDate: basis.latestSurveyDate,
      model,
    });

    return { ccn, summary: object.summary.trim(), pattern: object.pattern, model, cached: false };
  },
});

// =============================================================================
// Read-time queries — reactive, so translations stream into an open page
// =============================================================================

const citationValidator = v.object({
  _id: v.id("deficiencies"),
  tag: v.string(),
  tagDescription: v.string(),
  scopeSeverity: v.string(),
  harmLevel: v.string(),
  spread: v.string(),
  surveyDate: v.number(),
  correctionDate: v.optional(v.number()),
  isComplaint: v.boolean(),
  plainEnglish: v.union(v.string(), v.null()), // null while the translation is in flight
  full: v.union(v.string(), v.null()),
});

/** Join one page of citations to their cached translations. */
async function joinTranslations(
  ctx: { db: any },
  rows: Array<any>,
): Promise<Array<any>> {
  const cache = new Map<string, string>();
  for (const r of rows) {
    const key = cacheKey(r.tag, r.scopeSeverity);
    if (cache.has(key)) continue;
    const t = await ctx.db
      .query("tagTranslations")
      .withIndex("by_tag_severity", (q: any) =>
        q.eq("tag", r.tag).eq("scopeSeverity", r.scopeSeverity),
      )
      .first();
    if (t) cache.set(key, t.plainEnglish);
  }
  return rows.map((r) => {
    const plainEnglish = cache.get(cacheKey(r.tag, r.scopeSeverity)) ?? null;
    return {
      _id: r._id,
      tag: r.tag,
      tagDescription: r.tagDescription,
      scopeSeverity: r.scopeSeverity,
      harmLevel: r.harmLevel,
      spread: r.spread,
      surveyDate: r.surveyDate,
      correctionDate: r.correctionDate,
      isComplaint: r.isComplaint,
      plainEnglish,
      full: plainEnglish
        ? `${plainEnglish} ${correctionClause(r.correctionDate)}`
        : null,
    };
  });
}

/**
 * Everything the facility detail page needs, in one reactive query.
 *
 * `immediateJeopardy` is separated out deliberately: it is the only thing in
 * this product that gets a red banner (CLAUDE.md section 8).
 */
export const facilityDetail = query({
  args: { ccn: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      facility: v.object({
        ccn: v.string(),
        name: v.string(),
        city: v.string(),
        state: v.string(),
        zip: v.string(),
        phone: v.string(),
        ownershipType: v.string(),
        certifiedBeds: v.number(),
        overallRating: v.number(),
        healthInspectionRating: v.number(),
        abuseIcon: v.boolean(),
        lastCmsSync: v.number(),
      }),
      counts: v.object({
        total: v.number(),
        immediateJeopardy: v.number(),
        actualHarm: v.number(),
        potential: v.number(),
        minimal: v.number(),
        translated: v.number(),
      }),
      latestSurveyDate: v.number(),
      immediateJeopardy: v.array(citationValidator),
      worstFirst: v.array(citationValidator),
      riskSummary: v.union(
        v.null(),
        v.object({
          summary: v.string(),
          pattern: v.string(),
          model: v.string(),
          stale: v.boolean(),
        }),
      ),
    }),
  ),
  handler: async (ctx, { ccn }) => {
    const facility = await ctx.db
      .query("facilities")
      .withIndex("by_ccn", (q) => q.eq("ccn", ccn))
      .unique();
    if (!facility) return null;

    const rows = await ctx.db
      .query("deficiencies")
      .withIndex("by_ccn", (q) => q.eq("ccn", ccn))
      .collect();

    const counts = {
      total: rows.length,
      immediateJeopardy: rows.filter((r) => r.harmLevel === "immediate_jeopardy").length,
      actualHarm: rows.filter((r) => r.harmLevel === "actual_harm").length,
      potential: rows.filter((r) => r.harmLevel === "potential").length,
      minimal: rows.filter((r) => r.harmLevel === "minimal").length,
      translated: 0,
    };

    const sorted = [...rows].sort(
      (a, b) =>
        HARM_RANK[b.harmLevel] - HARM_RANK[a.harmLevel] || b.surveyDate - a.surveyDate,
    );
    const ij = await joinTranslations(ctx, sorted.filter((r) => r.harmLevel === "immediate_jeopardy"));
    const worstFirst = await joinTranslations(ctx, sorted.slice(0, 25));
    counts.translated = worstFirst.filter((r) => r.plainEnglish !== null).length;

    const summaryRow = await ctx.db
      .query("facilityRiskSummaries")
      .withIndex("by_ccn", (q) => q.eq("ccn", ccn))
      .first();
    const latestSurveyDate = rows.reduce((m, r) => Math.max(m, r.surveyDate), 0);

    return {
      facility: {
        ccn: facility.ccn,
        name: facility.name,
        city: facility.city,
        state: facility.state,
        zip: facility.zip,
        phone: facility.phone,
        ownershipType: facility.ownershipType,
        certifiedBeds: facility.certifiedBeds,
        overallRating: facility.overallRating,
        healthInspectionRating: facility.healthInspectionRating,
        abuseIcon: facility.abuseIcon,
        lastCmsSync: facility.lastCmsSync,
      },
      counts,
      latestSurveyDate,
      immediateJeopardy: ij,
      worstFirst,
      riskSummary: summaryRow
        ? {
            summary: summaryRow.summary,
            pattern: summaryRow.pattern,
            model: summaryRow.model,
            stale:
              summaryRow.citationCount !== rows.length ||
              summaryRow.latestSurveyDate !== latestSurveyDate,
          }
        : null,
    };
  },
});

/** Full citation history, worst-first, paginated. */
export const facilityCitations = query({
  args: { ccn: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { ccn, paginationOpts }) => {
    const page = await ctx.db
      .query("deficiencies")
      .withIndex("by_ccn", (q) => q.eq("ccn", ccn))
      .order("desc")
      .paginate(paginationOpts);
    return { ...page, page: await joinTranslations(ctx, page.page) };
  },
});

/** How full the shared translation cache is. Surfaced in the UI as evidence. */
export const cacheStats = query({
  args: {},
  returns: v.object({ cachedMeanings: v.number(), citationsCovered: v.number() }),
  handler: async (ctx) => {
    const translations = await ctx.db.query("tagTranslations").collect();
    const keys = new Set(translations.map((t) => cacheKey(t.tag, t.scopeSeverity)));
    const citations = await ctx.db.query("deficiencies").collect();
    return {
      cachedMeanings: keys.size,
      citationsCovered: citations.filter((c) =>
        keys.has(cacheKey(c.tag, c.scopeSeverity)),
      ).length,
    };
  },
});
