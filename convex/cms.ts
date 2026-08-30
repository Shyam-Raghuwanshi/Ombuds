import { v } from "convex/values";
import type { ActionCtx } from "./_generated/server";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";
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

/**
 * The same three coercions, but preserving the difference between "CMS
 * published nothing" and "CMS published zero".
 *
 * `num()` above is right for a rating, where a blank genuinely means unrated
 * and the UI already says so. It is wrong for a staffing figure: rendering an
 * unpublished night-nurse number as `0.0 hours` would put a false accusation
 * next to a real facility's name. These return undefined instead.
 */
const optStr = (row: CmsRow, key: string): string | undefined =>
  str(row, key) || undefined;
const optNum = (row: CmsRow, key: string): number | undefined => {
  const raw = str(row, key);
  if (!raw) return undefined;
  const n = Number(raw.replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : undefined;
};
const optBool = (row: CmsRow, key: string): boolean | undefined => {
  const raw = str(row, key).toUpperCase();
  if (raw !== "Y" && raw !== "N") return undefined;
  return raw === "Y";
};

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

/** The CMS-owned half of a facility document. Firecrawl's fields are patched
 * on separately and must never appear here — see `upsertFacility`. */
const facilityDoc = v.object({
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
  rnHoursWeekend: v.optional(v.number()),
  totalNurseHours: v.optional(v.number()),
  nurseTurnover: v.optional(v.number()),
  specialFocusStatus: v.optional(v.string()),
  numberOfFines: v.optional(v.number()),
  totalFinesUsd: v.optional(v.number()),
  changedOwnershipLast12Months: v.optional(v.boolean()),
  lastCmsSync: v.number(),
});

export const upsertFacility = internalMutation({
  args: { facility: facilityDoc },
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

/**
 * One CMS Provider Information row, coerced into a facility document.
 *
 * Shared by the single-facility pull and the full-catalog ingest so there is
 * exactly one place where a CMS column name is spelled, and a rename in the
 * federal schema cannot leave the two paths disagreeing about what a facility
 * is. Every value arrives as a string and nulls arrive as "" (CLAUDE.md
 * section 6, fact 1), so all coercion happens here and nowhere else.
 */
function facilityFromRow(r: CmsRow) {
  return {
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
      // Already computed by CMS, so never recomputed from other tables
      // (CLAUDE.md section 6, fact 6).
      rnHoursWeekend: optNum(
        r,
        "registered_nurse_hours_per_resident_per_day_on_the_weekend",
      ),
      totalNurseHours: optNum(
        r,
        "reported_total_nurse_staffing_hours_per_resident_per_day",
      ),
      nurseTurnover: optNum(r, "total_nursing_staff_turnover"),
      specialFocusStatus: optStr(r, "special_focus_status"),
      numberOfFines: optNum(r, "number_of_fines"),
      totalFinesUsd: optNum(r, "total_amount_of_fines_in_dollars"),
      changedOwnershipLast12Months: optBool(
        r,
        "provider_changed_ownership_in_last_12_months",
      ),
      lastCmsSync: Date.now(),
  };
}

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
      facility: facilityFromRow(r),
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
  returns: v.object({
    stored: v.number(),
    firstIngest: v.boolean(),
    // Harm-level citations present this month that were not there last month.
    // Empty on a first ingest, because everything is new and nothing changed.
    newHarm: v.array(
      v.object({
        tag: v.string(),
        tagDescription: v.string(),
        scopeSeverity: v.string(),
        surveyDate: v.number(),
        immediateJeopardy: v.boolean(),
      }),
    ),
  }),
  handler: async (ctx, { ccn, rows }) => {
    // CMS reissues the whole history for a facility each month, so replace
    // rather than merge — that way a withdrawn citation actually disappears.
    const existing = await ctx.db
      .query("deficiencies")
      .withIndex("by_ccn", (q) => q.eq("ccn", ccn))
      .collect();

    // A citation's identity, for the month-over-month diff. Tag, severity and
    // survey date together: the same tag cited again at a later inspection is a
    // NEW finding, and collapsing them would hide exactly the pattern a family
    // most needs to see.
    const key = (d: { tag: string; scopeSeverity: string; surveyDate: number }) =>
      `${d.tag}|${d.scopeSeverity}|${d.surveyDate}`;
    const before = new Set(existing.map(key));
    const firstIngest = existing.length === 0;

    for (const doc of existing) await ctx.db.delete(doc._id);
    for (const row of rows) await ctx.db.insert("deficiencies", row);

    const newHarm = firstIngest
      ? []
      : rows
          .filter(
            (r) =>
              (r.harmLevel === "actual_harm" ||
                r.harmLevel === "immediate_jeopardy") &&
              !before.has(key(r)),
          )
          .map((r) => ({
            tag: r.tag,
            tagDescription: r.tagDescription,
            scopeSeverity: r.scopeSeverity,
            surveyDate: r.surveyDate,
            immediateJeopardy: r.harmLevel === "immediate_jeopardy",
          }));

    return { stored: rows.length, firstIngest, newHarm };
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
/** A harm-level citation that appeared between two monthly CMS publications. */
export type NewHarmCitation = {
  tag: string;
  tagDescription: string;
  scopeSeverity: string;
  surveyDate: number;
  immediateJeopardy: boolean;
};

type DeficiencyPull = {
  ccn: string;
  fetched: number;
  stored: number;
  skippedBadSeverity: number;
  missingFullText: number;
  newHarm: NewHarmCitation[];
};

const newHarmValidator = v.array(
  v.object({
    tag: v.string(),
    tagDescription: v.string(),
    scopeSeverity: v.string(),
    surveyDate: v.number(),
    immediateJeopardy: v.boolean(),
  }),
);

export const ingestDeficiencies = action({
  args: { ccn: v.string() },
  returns: v.object({
    ccn: v.string(),
    fetched: v.number(),
    stored: v.number(),
    skippedBadSeverity: v.number(),
    missingFullText: v.number(),
    newHarm: newHarmValidator,
  }),
  handler: async (ctx, { ccn }) => await pullDeficiencies(ctx, ccn),
});

async function pullDeficiencies(
  ctx: ActionCtx,
  ccn: string,
): Promise<DeficiencyPull> {
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

    const result = await ctx.runMutation(internal.cms.replaceDeficiencies, {
      ccn,
      rows,
    });
    return {
      ccn,
      fetched: raw.length,
      stored: result.stored,
      skippedBadSeverity,
      missingFullText,
      newHarm: result.newHarm,
    };
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
    newHarm: newHarmValidator,
  }),
  handler: async (ctx, { ccn }) => {
    const facility = await pullFacility(ctx, ccn);
    if (!facility.found) {
      return { ccn, name: "", found: false, deficiencies: 0, newHarm: [] };
    }
    const defs = await pullDeficiencies(ctx, ccn);
    return {
      ccn,
      name: facility.name,
      found: true,
      deficiencies: defs.stored,
      newHarm: defs.newHarm,
    };
  },
});

// =============================================================================
// The full catalog — every certified facility in the country
// =============================================================================

/**
 * Upsert a page of facilities in one transaction.
 *
 * Patches rather than replaces, for the same reason `upsertFacility` does: a
 * re-run must not clobber the website, contact address, or enrichment that
 * Firecrawl found. Those columns are not in `facilityDoc` and so cannot be
 * written from here even by accident.
 */
export const upsertFacilityBatch = internalMutation({
  args: { facilities: v.array(facilityDoc) },
  returns: v.object({ inserted: v.number(), updated: v.number() }),
  handler: async (ctx, { facilities }) => {
    let inserted = 0;
    let updated = 0;
    for (const facility of facilities) {
      const existing = await ctx.db
        .query("facilities")
        .withIndex("by_ccn", (q) => q.eq("ccn", facility.ccn))
        .unique();
      if (existing) {
        await ctx.db.patch(existing._id, facility);
        updated += 1;
      } else {
        await ctx.db.insert("facilities", facility);
        inserted += 1;
      }
    }
    return { inserted, updated };
  },
});

/** CMS caps a page at 1000 rows; writes are chunked below that per transaction. */
const INGEST_WRITE_CHUNK = 250;

/**
 * Ingest the whole Provider Information dataset — ~14,690 facilities.
 *
 * This is the one CMS table it is correct to pull in bulk. It is 14,690 rows,
 * one per facility, and the product cannot answer "what is near this ZIP"
 * without all of them. Health Deficiencies is the opposite case at 419,479
 * rows, and stays lazy and per-facility (CLAUDE.md section 6) — nothing here
 * touches it, and nothing here calls a model, so a full run costs zero dollars
 * and only CMS's own rate limit.
 *
 * Paged through the scheduler rather than looped in one action: fifteen CMS
 * round trips and ~15,000 writes do not belong in a single transaction or a
 * single action timeout.
 */
export const ingestAllFacilities = internalAction({
  args: {
    offset: v.optional(v.number()),
    inserted: v.optional(v.number()),
    updated: v.optional(v.number()),
  },
  returns: v.object({
    offset: v.number(),
    inserted: v.number(),
    updated: v.number(),
    done: v.boolean(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    offset: number;
    inserted: number;
    updated: number;
    done: boolean;
  }> => {
    const offset = args.offset ?? 0;
    let inserted = args.inserted ?? 0;
    let updated = args.updated ?? 0;

    const rows = await cmsQuery(PROVIDER_INFO, [], MAX_PAGE, offset);
    const facilities = rows
      .map(facilityFromRow)
      // A row with no CCN is not addressable by anything else in the product.
      .filter((f) => f.ccn !== "");

    for (let i = 0; i < facilities.length; i += INGEST_WRITE_CHUNK) {
      const result = await ctx.runMutation(internal.cms.upsertFacilityBatch, {
        facilities: facilities.slice(i, i + INGEST_WRITE_CHUNK),
      });
      inserted += result.inserted;
      updated += result.updated;
    }

    const done = rows.length < MAX_PAGE;
    const nextOffset = offset + rows.length;

    if (done) {
      console.log(
        `[cms] full facility ingest complete: ${inserted} inserted, ` +
          `${updated} updated, ${inserted + updated} total`,
      );
    } else {
      console.log(
        `[cms] full facility ingest: ${inserted + updated} facilities through ` +
          `offset ${nextOffset}`,
      );
      await ctx.scheduler.runAfter(0, internal.cms.ingestAllFacilities, {
        offset: nextOffset,
        inserted,
        updated,
      });
    }

    return { offset: nextOffset, inserted, updated, done };
  },
});

/**
 * Kick off the full ingest and return immediately.
 *
 * Deliberately not awaited to completion: fifteen chained pages take a few
 * minutes, which is longer than any caller should hold a connection open for.
 */
export const startFullIngest = action({
  args: {},
  returns: v.object({ started: v.boolean() }),
  handler: async (ctx): Promise<{ started: boolean }> => {
    await ctx.scheduler.runAfter(0, internal.cms.ingestAllFacilities, {});
    return { started: true };
  },
});

// =============================================================================
// The monthly refresh — and the reason it is not decoration
// =============================================================================

/**
 * CMS republishes the whole inspection record on the first of every month.
 *
 * A family shortlists twelve homes in March and signs a contract in May. In
 * between, one of those twelve is cited for a fall that actually harmed a
 * resident. It is published, it is public, and absolutely nothing tells them —
 * because they already did their research, and research is a thing you do once.
 *
 * This is the sweep that closes that gap: re-pull each facility, diff the
 * citation history against what we had, and for every harm-level citation that
 * was not there before, raise an alert on every active search that is watching
 * that facility. That is a genuinely correct use of a cron rather than a
 * decorative one (CLAUDE.md section 5).
 */
export const refreshFacilitiesPage = internalAction({
  args: {
    cursor: v.union(v.string(), v.null()),
    batchSize: v.optional(v.number()),
    checked: v.optional(v.number()),
    alerted: v.optional(v.number()),
  },
  returns: v.object({ checked: v.number(), alerted: v.number() }),
  handler: async (
    ctx,
    { cursor, batchSize, checked, alerted },
  ): Promise<{ checked: number; alerted: number }> => {
    // Small pages, chained through the scheduler: one action must not try to
    // hold 14,690 facilities and a CMS round trip for each of them.
    const size = batchSize ?? 10;
    const page: {
      ccns: string[];
      cursor: string | null;
      isDone: boolean;
    } = await ctx.runQuery(internal.cms.facilityPage, { cursor, size });

    let checkedSoFar = checked ?? 0;
    let alertedSoFar = alerted ?? 0;

    for (const ccn of page.ccns) {
      try {
        await pullFacility(ctx, ccn);
        const defs = await pullDeficiencies(ctx, ccn);
        checkedSoFar += 1;
        if (defs.newHarm.length > 0) {
          const raised: number = await ctx.runMutation(internal.cms.raiseAlerts, {
            ccn,
            citations: defs.newHarm,
          });
          alertedSoFar += raised;
        }
      } catch (error) {
        // One facility CMS will not serve today must not stop the sweep.
        console.error(`[cms] monthly refresh failed for ${ccn}: ${error}`);
      }
    }

    if (!page.isDone && page.cursor) {
      await ctx.scheduler.runAfter(0, internal.cms.refreshFacilitiesPage, {
        cursor: page.cursor,
        batchSize: size,
        checked: checkedSoFar,
        alerted: alertedSoFar,
      });
    } else {
      console.log(
        `[cms] monthly refresh complete: ${checkedSoFar} facilities re-checked, ` +
          `${alertedSoFar} new harm alerts raised`,
      );
    }

    return { checked: checkedSoFar, alerted: alertedSoFar };
  },
});

export const facilityPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()), size: v.number() },
  returns: v.object({
    ccns: v.array(v.string()),
    cursor: v.union(v.string(), v.null()),
    isDone: v.boolean(),
  }),
  handler: async (ctx, { cursor, size }) => {
    const page = await ctx.db
      .query("facilities")
      .paginate({ cursor, numItems: size });
    return {
      ccns: page.page.map((f) => f.ccn),
      cursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

/**
 * Attach newly-found harm citations to the searches that are watching.
 *
 * Only searches with a live inquiry for this facility get an alert: we are
 * telling a specific family that a specific home on their specific shortlist
 * was cited, which is the only version of this that is useful rather than
 * alarming. Deduped by (search, tag, survey date) so a re-run of the sweep
 * cannot raise the same alarm twice.
 */
export const raiseAlerts = internalMutation({
  args: { ccn: v.string(), citations: newHarmValidator },
  returns: v.number(),
  handler: async (ctx, { ccn, citations }) => {
    const inquiries = await ctx.db
      .query("inquiries")
      .withIndex("by_ccn", (q) => q.eq("ccn", ccn))
      .collect();
    if (inquiries.length === 0) return 0;

    const facility = await ctx.db
      .query("facilities")
      .withIndex("by_ccn", (q) => q.eq("ccn", ccn))
      .unique();
    const facilityName = facility?.name ?? inquiries[0].facilityName;

    const searchIds = [...new Set(inquiries.map((i) => i.searchId))];
    let raised = 0;

    for (const searchId of searchIds) {
      const existing = await ctx.db
        .query("facilityAlerts")
        .withIndex("by_search_ccn", (q) =>
          q.eq("searchId", searchId).eq("ccn", ccn),
        )
        .collect();
      const seen = new Set(existing.map((a) => `${a.tag}|${a.surveyDate}`));

      for (const c of citations) {
        if (seen.has(`${c.tag}|${c.surveyDate}`)) continue;
        await ctx.db.insert("facilityAlerts", {
          searchId,
          ccn,
          facilityName,
          kind: c.immediateJeopardy ? "new_immediate_jeopardy" : "new_actual_harm",
          tag: c.tag,
          tagDescription: c.tagDescription,
          scopeSeverity: c.scopeSeverity,
          surveyDate: c.surveyDate,
          detectedAt: Date.now(),
        });
        raised += 1;
      }
    }
    return raised;
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
