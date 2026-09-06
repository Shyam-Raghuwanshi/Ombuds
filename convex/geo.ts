import { v } from "convex/values";
import {
  action,
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";
import { components, internal, api } from "./_generated/api";
import { GeospatialIndex } from "@convex-dev/geospatial";
import type { Id } from "./_generated/dataModel";

/**
 * "Homes near me", which is the question a family actually arrives with.
 *
 * CMS ships latitude and longitude on all 14,690 facilities but says nothing
 * about where a ZIP code is, and a family types a ZIP. So the origin of every
 * search is derived from the facilities CMS already places inside that ZIP —
 * no geocoding vendor, no extra key, and accurate to well inside the radius
 * anyone searches at.
 *
 * The radius search itself is the @convex-dev/geospatial component: facility
 * positions live in an S2 cell index keyed by CCN, and a search asks it for the
 * nearest N within a distance. It returns them ordered and bounded, so the
 * handler only ever reads the rows it is about to return.
 */

/**
 * The S2-backed index of every facility's position.
 *
 * Keyed by CCN, which is the federal certification number and already the
 * unique key for a facility everywhere else in this codebase — so a point and
 * its facility row can never drift apart or need reconciling.
 */
export const facilityIndex = new GeospatialIndex<string, {}>(
  components.geospatial,
);

/** The spatial index speaks metres; every figure a family sees is in miles. */
const METRES_PER_MILE = 1609.344;

// =============================================================================
// Building the ZIP index
// =============================================================================

/**
 * Fold one page of facilities into the ZIP centroid table.
 *
 * Averages incrementally — `mean' = (mean * n + x) / (n + 1)` — so the table
 * is correct after every page rather than only at the end, and a run that dies
 * halfway leaves usable data instead of a half-built index.
 */
export const accumulateZipPage = internalMutation({
  args: {
    points: v.array(
      v.object({
        zip: v.string(),
        latitude: v.number(),
        longitude: v.number(),
      }),
    ),
  },
  returns: v.number(),
  handler: async (ctx, { points }) => {
    let written = 0;
    for (const p of points) {
      // CMS publishes ZIP+4 for some rows and "" for a few. Only the leading
      // five digits identify the delivery area, and a row without them cannot
      // be placed on a map at all.
      const zip = p.zip.trim().slice(0, 5);
      if (zip.length !== 5 || !/^\d{5}$/.test(zip)) continue;
      // 0,0 is the Gulf of Guinea, and it is what CMS publishes when it has no
      // coordinate. Averaging it in would drag a ZIP's centre into the ocean.
      if (p.latitude === 0 && p.longitude === 0) continue;

      const existing = await ctx.db
        .query("zipCentroids")
        .withIndex("by_zip", (q) => q.eq("zip", zip))
        .unique();

      if (!existing) {
        await ctx.db.insert("zipCentroids", {
          zip,
          zip3: zip.slice(0, 3),
          latitude: p.latitude,
          longitude: p.longitude,
          facilityCount: 1,
        });
      } else {
        const n = existing.facilityCount;
        await ctx.db.patch(existing._id, {
          latitude: (existing.latitude * n + p.latitude) / (n + 1),
          longitude: (existing.longitude * n + p.longitude) / (n + 1),
          facilityCount: n + 1,
        });
      }
      written += 1;
    }
    return written;
  },
});

/** One page of facility coordinates, for the centroid build. */
export const facilityPointPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()), size: v.number() },
  returns: v.object({
    points: v.array(
      v.object({
        zip: v.string(),
        latitude: v.number(),
        longitude: v.number(),
      }),
    ),
    cursor: v.union(v.string(), v.null()),
    isDone: v.boolean(),
  }),
  handler: async (ctx, { cursor, size }) => {
    const page = await ctx.db
      .query("facilities")
      .paginate({ cursor, numItems: size });
    return {
      points: page.page.map((f) => ({
        zip: f.zip,
        latitude: f.latitude,
        longitude: f.longitude,
      })),
      cursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

/**
 * Walk the facility table and build the ZIP index, one page at a time.
 *
 * Re-runnable, but not idempotent on its own: the averages accumulate, so a
 * second run over the same facilities would weight them twice. Call
 * `rebuildZipIndex` rather than this, which clears first.
 */
export const buildZipCentroidsPage = internalMutation({
  args: {
    cursor: v.union(v.string(), v.null()),
    written: v.optional(v.number()),
  },
  returns: v.object({ written: v.number(), done: v.boolean() }),
  // Annotated because the handler schedules itself, and Convex's generated
  // `internal.geo.*` type would otherwise be inferred from this very function.
  handler: async (
    ctx,
    { cursor, written },
  ): Promise<{ written: number; done: boolean }> => {
    const page: {
      points: Array<{ zip: string; latitude: number; longitude: number }>;
      cursor: string | null;
      isDone: boolean;
    } = await ctx.runQuery(internal.geo.facilityPointPage, {
      cursor,
      size: 400,
    });
    const added: number = await ctx.runMutation(internal.geo.accumulateZipPage, {
      points: page.points,
    });
    const total = (written ?? 0) + added;

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.geo.buildZipCentroidsPage, {
        cursor: page.cursor,
        written: total,
      });
      return { written: total, done: false };
    }
    console.log(`[geo] ZIP index built from ${total} facility coordinates`);
    return { written: total, done: true };
  },
});

/** Empty the ZIP index so a rebuild starts from zero rather than double-counting. */
export const clearZipCentroids = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: v.object({ done: v.boolean() }),
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db
      .query("zipCentroids")
      .paginate({ cursor, numItems: 400 });
    for (const row of page.page) await ctx.db.delete(row._id);

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.geo.clearZipCentroids, {
        cursor: page.continueCursor,
      });
      return { done: false };
    }
    await ctx.scheduler.runAfter(0, internal.geo.buildZipCentroidsPage, {
      cursor: null,
    });
    return { done: true };
  },
});

/**
 * Rebuild the ZIP index from the current facility table.
 *
 * Run after a full CMS ingest. Clears first, then rebuilds, both chained
 * through the scheduler.
 */
export const rebuildZipIndex = action({
  args: {},
  returns: v.object({ started: v.boolean() }),
  handler: async (ctx): Promise<{ started: boolean }> => {
    await ctx.scheduler.runAfter(0, internal.geo.clearZipCentroids, {
      cursor: null,
    });
    return { started: true };
  },
});

// =============================================================================
// Looking a ZIP up
// =============================================================================

export type ZipOrigin = {
  latitude: number;
  longitude: number;
  /** Whether we found the ZIP itself or fell back to its three-digit area. */
  precision: "zip" | "zip3";
  facilityCount: number;
};

/**
 * Where to measure from.
 *
 * Exact ZIP first. Failing that, the average of every ZIP sharing its first
 * three digits — the postal sectional centre, roughly county-sized. A family
 * in a ZIP with no certified facility of its own still gets a real search
 * rather than an error, and the UI says which of the two it got.
 */
export const resolveZip = internalQuery({
  args: { zip: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      latitude: v.number(),
      longitude: v.number(),
      precision: v.union(v.literal("zip"), v.literal("zip3")),
      facilityCount: v.number(),
    }),
  ),
  handler: async (ctx, { zip }) => {
    const clean = zip.trim().slice(0, 5);
    if (!/^\d{5}$/.test(clean)) return null;

    const exact = await ctx.db
      .query("zipCentroids")
      .withIndex("by_zip", (q) => q.eq("zip", clean))
      .unique();
    if (exact) {
      return {
        latitude: exact.latitude,
        longitude: exact.longitude,
        precision: "zip" as const,
        facilityCount: exact.facilityCount,
      };
    }

    const area = await ctx.db
      .query("zipCentroids")
      .withIndex("by_zip3", (q) => q.eq("zip3", clean.slice(0, 3)))
      .collect();
    if (area.length === 0) return null;

    // Weight by facility count so a dense urban ZIP pulls the centre more than
    // a rural one with a single home — closer to where people actually are.
    const total = area.reduce((s, r) => s + r.facilityCount, 0);
    return {
      latitude: area.reduce((s, r) => s + r.latitude * r.facilityCount, 0) / total,
      longitude: area.reduce((s, r) => s + r.longitude * r.facilityCount, 0) / total,
      precision: "zip3" as const,
      facilityCount: total,
    };
  },
});

// =============================================================================
// The radius search
// =============================================================================

export type NearbyFacility = {
  ccn: string;
  name: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  distanceMiles: number;
  overallRating: number;
  abuseIcon: boolean;
  specialFocusStatus: string | null;
  certifiedBeds: number;
};

export type NearbyResult = {
  origin: {
    latitude: number;
    longitude: number;
    precision: "zip" | "zip3";
  } | null;
  facilities: NearbyFacility[];
};

const nearbyRow = v.object({
  ccn: v.string(),
  name: v.string(),
  city: v.string(),
  state: v.string(),
  zip: v.string(),
  phone: v.string(),
  distanceMiles: v.number(),
  overallRating: v.number(),
  abuseIcon: v.boolean(),
  specialFocusStatus: v.union(v.string(), v.null()),
  certifiedBeds: v.number(),
});

/**
 * Certified facilities within `radiusMiles` of a ZIP, nearest first.
 *
 * Reactive, so a board built on it updates itself as enrichment fills in.
 * Returns everything it finds — including facilities with a poor record, an
 * abuse flag, or no published contact address. Filtering those out is exactly
 * what a referral service paid by facilities does, and is the thing this
 * product exists to not do (CLAUDE.md section 4).
 */
export const facilitiesNearZip = query({
  args: {
    zip: v.string(),
    radiusMiles: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    origin: v.union(
      v.null(),
      v.object({
        latitude: v.number(),
        longitude: v.number(),
        precision: v.union(v.literal("zip"), v.literal("zip3")),
      }),
    ),
    facilities: v.array(nearbyRow),
  }),
  handler: async (ctx, { zip, radiusMiles, limit }): Promise<NearbyResult> => {
    const radius = radiusMiles ?? 25;
    const origin: ZipOrigin | null = await ctx.runQuery(
      internal.geo.resolveZip,
      { zip },
    );
    if (!origin) return { origin: null, facilities: [] };

    // The S2 index does the geometry. It returns the nearest keys already
    // ordered and already bounded by distance, so nothing here reads a row it
    // is not going to return — which is the difference between this and
    // scanning a latitude band and throwing most of it away.
    const want = limit ?? 60;
    const nearest = await facilityIndex.queryNearest(
      ctx,
      { latitude: origin.latitude, longitude: origin.longitude },
      want,
      radius * METRES_PER_MILE,
    );

    const facilities: NearbyFacility[] = [];
    for (const hit of nearest) {
      const f = await ctx.db
        .query("facilities")
        .withIndex("by_ccn", (q) => q.eq("ccn", hit.key))
        .unique();
      if (!f) continue;
      facilities.push({
        ccn: f.ccn,
        name: f.name,
        city: f.city,
        state: f.state,
        zip: f.zip,
        phone: f.phone,
        // The index reports metres along the sphere; the product speaks miles.
        distanceMiles: hit.distance / METRES_PER_MILE,
        overallRating: f.overallRating,
        abuseIcon: f.abuseIcon,
        specialFocusStatus: f.specialFocusStatus ?? null,
        certifiedBeds: f.certifiedBeds,
      });
    }

    return {
      origin: {
        latitude: origin.latitude,
        longitude: origin.longitude,
        precision: origin.precision,
      },
      facilities,
    };
  },
});

// =============================================================================
// Starting a real search
// =============================================================================

/** How many facilities one family's campaign writes to. */
const CAMPAIGN_SIZE = 12;

/**
 * The real front door: a family's own ZIP, their own budget, their own list.
 *
 * Same machinery as the judge cold-open — it differs only in that the shortlist
 * is computed from where this family is looking instead of being the twelve
 * facilities the sample search names.
 *
 * Returns as soon as the search row exists so the board can render while the
 * campaign is still being written behind it, exactly as `runSampleSearch` does.
 */
export const startSearchNearZip = action({
  args: {
    label: v.string(),
    zip: v.string(),
    radiusMiles: v.optional(v.number()),
    careLevel: v.union(
      v.literal("independent"),
      v.literal("assisted"),
      v.literal("memory"),
      v.literal("skilled"),
    ),
    budgetMax: v.optional(v.number()),
    mustHaves: v.optional(v.array(v.string())),
  },
  returns: v.object({
    searchId: v.union(v.null(), v.id("searches")),
    matched: v.number(),
    reason: v.string(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    searchId: Id<"searches"> | null;
    matched: number;
    reason: string;
  }> => {
    const radius = args.radiusMiles ?? 25;
    const near: NearbyResult = await ctx.runQuery(api.geo.facilitiesNearZip, {
      zip: args.zip,
      radiusMiles: radius,
      limit: CAMPAIGN_SIZE,
    });

    // Say which of the two went wrong. "No facilities found" reads as a broken
    // product when the real answer is that the ZIP was mistyped.
    if (!near.origin) {
      return { searchId: null, matched: 0, reason: "unknown_zip" };
    }
    if (near.facilities.length === 0) {
      return { searchId: null, matched: 0, reason: "none_in_radius" };
    }

    const created: { searchId: Id<"searches"> } = await ctx.runAction(
      api.searches.createSearch,
      {
        label: args.label,
        zip: args.zip,
        radiusMiles: radius,
        careLevel: args.careLevel,
        budgetMax: args.budgetMax,
        mustHaves: args.mustHaves ?? [],
        isSample: false,
      },
    );

    const ccns = near.facilities.map((f) => f.ccn);

    // Discovery first, because these facilities have almost certainly never
    // been looked at. CMS publishes a phone number and nothing else, so until
    // Firecrawl has been out on the open web there is no address to write to
    // (CLAUDE.md section 4). Queued rather than awaited — it runs through the
    // bounded enrichment pool while the board is already on screen.
    await ctx.runMutation(api.enrichment.enrichBatch, { ccns });

    // The campaign does not wait for it. Rows and inspection records land in
    // about a second; the letters go to whichever facilities are already
    // reachable.
    await ctx.scheduler.runAfter(0, internal.searches.runCampaign, {
      searchId: created.searchId,
      ccns,
    });

    // Then sweep up the ones whose address arrived while the campaign was
    // running. Three passes on a widening interval, because Firecrawl's
    // per-minute rate limit means twelve facilities do not all come back at
    // once, and a single pass would miss the slow half.
    for (const delayMs of [45_000, 100_000, 180_000]) {
      await ctx.scheduler.runAfter(
        delayMs,
        internal.searches.backfillDiscoveredEmails,
        { searchId: created.searchId },
      );
    }

    return {
      searchId: created.searchId,
      matched: near.facilities.length,
      reason: "started",
    };
  },
});

// =============================================================================
// Populating the spatial index
// =============================================================================

/** Points written per transaction. Each insert writes several S2 cells. */
const INDEX_CHUNK = 100;

/**
 * Write one page of facilities into the spatial index.
 *
 * Keyed by CCN, so a re-run overwrites rather than duplicating and the sweep is
 * safe to restart from anywhere.
 */
export const indexFacilityPage = internalMutation({
  args: {
    cursor: v.union(v.string(), v.null()),
    indexed: v.optional(v.number()),
  },
  returns: v.object({ indexed: v.number(), done: v.boolean() }),
  handler: async (ctx, { cursor, indexed }) => {
    const page = await ctx.db
      .query("facilities")
      .paginate({ cursor, numItems: INDEX_CHUNK });

    let total = indexed ?? 0;
    for (const f of page.page) {
      // 0,0 is the Gulf of Guinea and is what CMS publishes when it holds no
      // coordinate. Indexing it would put a Californian nursing home in the
      // Atlantic and return it for searches nowhere near it.
      if (f.latitude === 0 && f.longitude === 0) continue;
      await facilityIndex.insert(
        ctx,
        f.ccn,
        { latitude: f.latitude, longitude: f.longitude },
        {},
      );
      total += 1;
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.geo.indexFacilityPage, {
        cursor: page.continueCursor,
        indexed: total,
      });
      return { indexed: total, done: false };
    }
    console.log(`[geo] spatial index built: ${total} facilities`);
    return { indexed: total, done: true };
  },
});

/** Build the spatial index from the current facility table. */
export const rebuildSpatialIndex = action({
  args: {},
  returns: v.object({ started: v.boolean() }),
  handler: async (ctx): Promise<{ started: boolean }> => {
    await ctx.scheduler.runAfter(0, internal.geo.indexFacilityPage, {
      cursor: null,
    });
    return { started: true };
  },
});
