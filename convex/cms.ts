import { v } from "convex/values";
import type { ActionCtx } from "./_generated/server";
import { action, internalMutation, internalQuery, query } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  harmLevelFor,
  spreadFor,
  isValidScopeSeverity,
  normalizeTag,
  parseCmsDate,
} from "./lib/severity";

/**
 * CMS Provider Data Catalog. Free, public, updated monthly.
 * Verified live against data stamped 2026-08-01. CLAUDE.md section 6.
 *
 * Every value in every column arrives as a string, and nulls arrive as "".
 * Coerce on ingest — this is fact 1 of the six that cause bugs.
 */

const API = "https://data.cms.gov/provider-data/api/1/datastore/query";
const PROVIDER_INFO = "4pq5-n9py"; // 14,690 rows
const HEALTH_DEFICIENCIES = "r5ix-sfxw"; // 419,479 rows — never bulk ingest
const CITATION_LOOKUP = "tagd-9999"; // 643 rows
const MAX_PAGE = 1000; // verified: 5000 fails

type CmsRow = Record<string, string>;

/** Server-side filtered, paginated query against one CMS dataset. */
async function cmsQuery(
  datasetId: string,
  conditions: Array<{ property: string; value: string }>,
  limit: number,
  offset: number,
): Promise<CmsRow[]> {
  const params = new URLSearchParams({
    limit: String(Math.min(limit, MAX_PAGE)),
    offset: String(offset),
  });
  conditions.forEach((c, i) => {
    params.set(`conditions[${i}][property]`, c.property);
    params.set(`conditions[${i}][value]`, c.value);
    params.set(`conditions[${i}][operator]`, "=");
  });
  const res = await fetch(`${API}/${datasetId}/0?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`CMS ${datasetId} returned ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { results: CmsRow[] };
  return body.results ?? [];
}

/** Follow pagination to the end. Only ever used with a filter that bounds it. */
async function cmsQueryAll(
  datasetId: string,
  conditions: Array<{ property: string; value: string }>,
  hardCap = 5000,
): Promise<CmsRow[]> {
  const out: CmsRow[] = [];
  let offset = 0;
  for (;;) {
    const page = await cmsQuery(datasetId, conditions, MAX_PAGE, offset);
    out.push(...page);
    if (page.length < MAX_PAGE || out.length >= hardCap) return out;
    offset += MAX_PAGE;
  }
}

// --- coercion ----------------------------------------------------------------

const str = (row: CmsRow, key: string): string => (row[key] ?? "").trim();
const num = (row: CmsRow, key: string): number => {
  const n = Number(str(row, key));
  return Number.isFinite(n) ? n : 0;
};
/** CMS writes "Y"/"N", and "" for unknown. */
const bool = (row: CmsRow, key: string): boolean =>
  str(row, key).toUpperCase() === "Y";

// =============================================================================
// Citation Code Look-up — the full, untruncated text of every tag.
// =============================================================================

/**
 * The `deficiency_description` on a citation row is truncated mid-sentence
 * ("...provides adequate supervision to prevent acc"). The look-up table has
 * the real wording. 643 rows, static, no LLM. CLAUDE.md section 6, fact 3.
 */
export const syncTagCatalog = action({
  args: {},
  returns: v.object({ fetched: v.number(), written: v.number() }),
  handler: async (ctx): Promise<{ fetched: number; written: number }> => {
    const rows = await cmsQueryAll(CITATION_LOOKUP, []);
    const entries = rows.map((r) => ({
      tag: normalizeTag(str(r, "deficiency_prefix"), str(r, "deficiency_tag_number")),
      prefix: str(r, "deficiency_prefix"),
      number: str(r, "deficiency_tag_number"),
      description: str(r, "deficiency_description"),
      category: str(r, "deficiency_category"),
    }));
    const written = await ctx.runMutation(internal.cms.upsertTagCatalog, { entries });
    return { fetched: rows.length, written };
  },
});

export const upsertTagCatalog = internalMutation({
  args: {
    entries: v.array(
      v.object({
        tag: v.string(),
        prefix: v.string(),
        number: v.string(),
        description: v.string(),
        category: v.string(),
      }),
    ),
  },
  returns: v.number(),
  handler: async (ctx, { entries }) => {
    let written = 0;
    for (const e of entries) {
      const existing = await ctx.db
        .query("tagCatalog")
        .withIndex("by_tag", (q) => q.eq("tag", e.tag))
        .unique();
      if (existing) {
        if (existing.description !== e.description) {
          await ctx.db.patch(existing._id, e);
          written++;
        }
      } else {
        await ctx.db.insert("tagCatalog", e);
        written++;
      }
    }
    return written;
  },
});

// =============================================================================
// Facilities
// =============================================================================

export const upsertFacility = internalMutation({
  args: {
    facility: v.object({
      ccn: v.string(),
      name: v.string(),
      address: v.string(),
      city: v.string(),
      state: v.string(),
      zip: v.string(),
      county: v.string(),
      phone: v.string(),
      ownershipType: v.string(),
      certifiedBeds: v.number(),
      overallRating: v.number(),
      healthInspectionRating: v.number(),
      staffingRating: v.number(),
      qmRating: v.number(),
      abuseIcon: v.boolean(),
      latitude: v.number(),
      longitude: v.number(),
      lastCmsSync: v.number(),
    }),
  },
  returns: v.id("facilities"),
  handler: async (ctx, { facility }) => {
    const existing = await ctx.db
      .query("facilities")
      .withIndex("by_ccn", (q) => q.eq("ccn", facility.ccn))
      .unique();
    if (existing) {
      // Patch, never replace: this must not clobber Firecrawl's contactEmail,
      // website, or enrichment on the monthly CMS refresh.
      await ctx.db.patch(existing._id, facility);
      return existing._id;
    }
    return await ctx.db.insert("facilities", facility);
  },
});

/**
 * Pull one facility's Provider Information row.
 *
 * Ratings arrive as "" for Special Focus Facilities, so a 0 here means
 * "CMS published no rating", not "rated zero". The UI must say so rather than
 * drawing an empty star bar.
 */
export const ingestFacility = action({
  args: { ccn: v.string() },
  returns: v.object({ ccn: v.string(), name: v.string(), found: v.boolean() }),
  handler: async (ctx, { ccn }) => await pullFacility(ctx, ccn),
});

async function pullFacility(
  ctx: ActionCtx,
  ccn: string,
): Promise<{ ccn: string; name: string; found: boolean }> {
  {
    const rows = await cmsQuery(
      PROVIDER_INFO,
      [{ property: "cms_certification_number_ccn", value: ccn }],
      1,
      0,
    );
    if (rows.length === 0) return { ccn, name: "", found: false };
    const r = rows[0];

    await ctx.runMutation(internal.cms.upsertFacility, {
      facility: {
        ccn: str(r, "cms_certification_number_ccn"),
        name: str(r, "provider_name"),
        address: str(r, "provider_address"),
        city: str(r, "citytown"),
        state: str(r, "state"),
        zip: str(r, "zip_code"),
        county: str(r, "countyparish"),
        phone: str(r, "telephone_number"),
        ownershipType: str(r, "ownership_type"),
        certifiedBeds: num(r, "number_of_certified_beds"),
        overallRating: num(r, "overall_rating"),
        healthInspectionRating: num(r, "health_inspection_rating"),
        staffingRating: num(r, "staffing_rating"),
        qmRating: num(r, "qm_rating"),
        abuseIcon: bool(r, "abuse_icon"),
        latitude: num(r, "latitude"),
        longitude: num(r, "longitude"),
        lastCmsSync: Date.now(),
      },
    });
    return { ccn, name: str(r, "provider_name"), found: true };
  }
}

// =============================================================================
// Deficiencies — loaded lazily, per facility, never in bulk
// =============================================================================

export const lookupTagDescriptions = internalQuery({
  args: { tags: v.array(v.string()) },
  returns: v.record(v.string(), v.string()),
  handler: async (ctx, { tags }) => {
    const out: Record<string, string> = {};
    for (const tag of [...new Set(tags)]) {
      const row = await ctx.db
        .query("tagCatalog")
        .withIndex("by_tag", (q) => q.eq("tag", tag))
        .unique();
      if (row) out[tag] = row.description;
    }
    return out;
  },
});

export const replaceDeficiencies = internalMutation({
  args: {
    ccn: v.string(),
    rows: v.array(
      v.object({
        ccn: v.string(),
        surveyDate: v.number(),
        tag: v.string(),
        tagDescription: v.string(),
        scopeSeverity: v.string(),
        harmLevel: v.union(
          v.literal("minimal"),
          v.literal("potential"),
          v.literal("actual_harm"),
          v.literal("immediate_jeopardy"),
        ),
        spread: v.union(
          v.literal("isolated"),
          v.literal("pattern"),
          v.literal("widespread"),
        ),
        isComplaint: v.boolean(),
        correctionDate: v.optional(v.number()),
      }),
    ),
  },
  returns: v.number(),
  handler: async (ctx, { ccn, rows }) => {
    // CMS reissues the whole history for a facility each month, so replace
    // rather than merge — that way a withdrawn citation actually disappears.
    const existing = await ctx.db
      .query("deficiencies")
      .withIndex("by_ccn", (q) => q.eq("ccn", ccn))
      .collect();
    for (const doc of existing) await ctx.db.delete(doc._id);
    for (const row of rows) await ctx.db.insert("deficiencies", row);
    return rows.length;
  },
});

/**
 * One facility's full citation history.
 *
 * Server-side filtering by CCN is what makes this affordable: the table has
 * 419,479 rows nationally and returns ~7-200 for one facility. We never touch
 * the 157.7 MB bulk CSV. CLAUDE.md section 6.
 *
 * No LLM is called here. Translation happens lazily on view (section 10).
 */
export const ingestDeficiencies = action({
  args: { ccn: v.string() },
  returns: v.object({
    ccn: v.string(),
    fetched: v.number(),
    stored: v.number(),
    skippedBadSeverity: v.number(),
    missingFullText: v.number(),
  }),
  handler: async (ctx, { ccn }) => await pullDeficiencies(ctx, ccn),
});

async function pullDeficiencies(
  ctx: ActionCtx,
  ccn: string,
): Promise<{
  ccn: string;
  fetched: number;
  stored: number;
  skippedBadSeverity: number;
  missingFullText: number;
}> {
  {
    const raw = await cmsQueryAll(HEALTH_DEFICIENCIES, [
      { property: "cms_certification_number_ccn", value: ccn },
    ]);

    const tags = raw.map((r) =>
      normalizeTag(str(r, "deficiency_prefix"), str(r, "deficiency_tag_number")),
    );
    const fullText = await ctx.runQuery(internal.cms.lookupTagDescriptions, { tags });

    let skippedBadSeverity = 0;
    let missingFullText = 0;
    const rows = [];

    for (const r of raw) {
      const scopeSeverity = str(r, "scope_severity_code").toUpperCase();
      if (!isValidScopeSeverity(scopeSeverity)) {
        // A handful of rows carry a blank or non-grid code. Drop them rather
        // than guess a harm level we would then show to a family.
        skippedBadSeverity++;
        continue;
      }
      const tag = normalizeTag(
        str(r, "deficiency_prefix"),
        str(r, "deficiency_tag_number"),
      );
      const truncated = str(r, "deficiency_description");
      const full = fullText[tag];
      if (!full) missingFullText++;

      rows.push({
        ccn,
        surveyDate: parseCmsDate(str(r, "survey_date")) ?? 0,
        tag,
        tagDescription: full ?? truncated,
        scopeSeverity,
        harmLevel: harmLevelFor(scopeSeverity),
        spread: spreadFor(scopeSeverity),
        isComplaint: str(r, "complaint_deficiency").toUpperCase() === "Y",
        correctionDate: parseCmsDate(str(r, "correction_date")),
      });
    }

    const stored = await ctx.runMutation(internal.cms.replaceDeficiencies, {
      ccn,
      rows,
    });
    return { ccn, fetched: raw.length, stored, skippedBadSeverity, missingFullText };
  }
}

/** Facility + its whole citation history, in one call. */
export const ingestFacilityByCcn = action({
  args: { ccn: v.string() },
  returns: v.object({
    ccn: v.string(),
    name: v.string(),
    found: v.boolean(),
    deficiencies: v.number(),
  }),
  handler: async (ctx, { ccn }) => {
    const facility = await pullFacility(ctx, ccn);
    if (!facility.found) return { ccn, name: "", found: false, deficiencies: 0 };
    const defs = await pullDeficiencies(ctx, ccn);
    return { ccn, name: facility.name, found: true, deficiencies: defs.stored };
  },
});

/** Has this facility been ingested yet? Used by the seed/demo path. */
export const isIngested = query({
  args: { ccn: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { ccn }) => {
    const f = await ctx.db
      .query("facilities")
      .withIndex("by_ccn", (q) => q.eq("ccn", ccn))
      .unique();
    return f !== null;
  },
});
