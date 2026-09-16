import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";
import { components, internal, api } from "./_generated/api";
import { GeospatialIndex } from "@convex-dev/geospatial";
import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { allow, busyMessage } from "./limits";

/**
 * "Homes near me", which is the question a family actually arrives with.
 *
 * CMS ships latitude and longitude on all 14,690 facilities but says nothing
 * about where a ZIP code is, and a family types a ZIP. We used to derive that
 * from the facilities CMS places inside each ZIP, falling back to the wider
 * three-digit postal area when a ZIP held none. Checked against the real
 * gazetteer, that was wrong for most of the country: only 21.5% of the 41,488
 * real US ZIPs contain a certified facility, and the fallback placed the other
 * 75.5% a median of 20.8 miles from where they actually are — further than the
 * 25 miles the search defaults to. A third of all ZIPs were off by more than
 * the entire search radius.
 *
 * So the origin now comes from a gazetteer of every US ZIP (`zipLocations`,
 * seeded from GeoNames). One indexed lookup, exact everywhere, and a ZIP that
 * is absent from it is not a ZIP — which is the only way to tell a family they
 * mistyped rather than quietly searching somewhere else.
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

/**
 * The one place that decides whether a string is a ZIP code.
 *
 * Validates the whole input and only then takes the first five digits. Doing
 * it the other way round — slice, then test the slice — passes anything whose
 * first five characters happen to be digits, so "91767x" and a pasted phone
 * number both resolve to Pomona. ZIP+4 is accepted in both the forms the post
 * office writes it; everything else is rejected rather than truncated into
 * something plausible.
 */
export function normalizeZip(input: string): string | null {
  const clean = input.trim();
  if (!/^\d{5}(?:-?\d{4})?$/.test(clean)) return null;
  return clean.slice(0, 5);
}

// =============================================================================
// The ZIP gazetteer
// =============================================================================

/**
 * Load one page of the ZIP gazetteer.
 *
 * Fed by `npm run seed:zips` from `data/us-zip-locations.csv`, which is the
 * GeoNames postal-code export trimmed to the five fields we use. Keyed by ZIP
 * and idempotent, so a re-run refreshes in place rather than duplicating and
 * the seed can be restarted from anywhere.
 */
export const upsertZipLocations = internalMutation({
  args: {
    rows: v.array(
      v.object({
        zip: v.string(),
        latitude: v.number(),
        longitude: v.number(),
        city: v.string(),
        state: v.string(),
      }),
    ),
  },
  returns: v.object({ inserted: v.number(), updated: v.number() }),
  handler: async (ctx, { rows }) => {
    let inserted = 0;
    let updated = 0;
    for (const r of rows) {
      const zip = normalizeZip(r.zip);
      if (zip === null) continue;
      const existing = await ctx.db
        .query("zipLocations")
        .withIndex("by_zip", (q) => q.eq("zip", zip))
        .unique();
      if (existing) {
        await ctx.db.patch(existing._id, {
          latitude: r.latitude,
          longitude: r.longitude,
          city: r.city,
          state: r.state,
        });
        updated += 1;
      } else {
        await ctx.db.insert("zipLocations", { ...r, zip });
        inserted += 1;
      }
    }
    return { inserted, updated };
  },
});

/**
 * One page of the gazetteer's size, so the seed can verify itself.
 *
 * The cursor is the caller's to hold: Convex allows a single paginated query
 * per function, and 41,488 rows is well past what one read should materialise
 * anyway.
 */
export const zipGazetteerPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: v.object({
    count: v.number(),
    cursor: v.union(v.string(), v.null()),
    isDone: v.boolean(),
  }),
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db
      .query("zipLocations")
      .paginate({ cursor, numItems: 4000 });
    return {
      count: page.page.length,
      cursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

// =============================================================================
// Looking a ZIP up
// =============================================================================

export type ZipOrigin = {
  latitude: number;
  longitude: number;
  city: string;
  state: string;
};

/**
 * Where to measure from.
 *
 * One indexed lookup against the gazetteer. A ZIP that is not in it is not a
 * ZIP, and saying so is the point: the previous version fell back to the
 * three-digit postal area, which meant a mistyped code such as 47300 came back
 * with real facilities in Muncie and no hint that the ZIP does not exist. The
 * fallback also had to be *told* it was guessing, which meant every caller and
 * every screen carried an approximate-or-not branch. None of that is needed
 * when the answer is simply correct.
 */
export const resolveZip = internalQuery({
  args: { zip: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      latitude: v.number(),
      longitude: v.number(),
      city: v.string(),
      state: v.string(),
    }),
  ),
  handler: async (ctx, { zip }) => {
    const clean = normalizeZip(zip);
    if (clean === null) return null;

    const row = await ctx.db
      .query("zipLocations")
      .withIndex("by_zip", (q) => q.eq("zip", clean))
      .unique();
    if (!row) return null;

    return {
      latitude: row.latitude,
      longitude: row.longitude,
      city: row.city,
      state: row.state,
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
  /** Null means the ZIP does not exist, not that nothing was found near it. */
  origin: {
    latitude: number;
    longitude: number;
    city: string;
    state: string;
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
        city: v.string(),
        state: v.string(),
      }),
    ),
    facilities: v.array(nearbyRow),
  }),
  handler: async (ctx, { zip, radiusMiles, limit }): Promise<NearbyResult> => {
    // Bounded, because both numbers come from the browser and set how much the
    // spatial index and the facility table are asked to read.
    const radius = Math.min(100, Math.max(1, radiusMiles ?? 25));
    const origin: ZipOrigin | null = await ctx.runQuery(
      internal.geo.resolveZip,
      { zip },
    );
    if (!origin) return { origin: null, facilities: [] };

    // The S2 index does the geometry. It returns the nearest keys already
    // ordered and already bounded by distance, so nothing here reads a row it
    // is not going to return — which is the difference between this and
    // scanning a latitude band and throwing most of it away.
    const want = Math.min(60, Math.max(1, limit ?? 60));
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
        city: origin.city,
        state: origin.state,
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
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("not signed in");

    // Every one of these is echoed onto the board, into an export, and — for
    // the label — into an inbox address, so none of them is unbounded.
    //
    // The ZIP is rejected outright rather than truncated: a search row carries
    // its ZIP into the email the facility receives, and "91767x" quietly
    // becoming Pomona is worse than being told to check the five digits.
    const zip = normalizeZip(args.zip);
    if (zip === null) {
      return { searchId: null, matched: 0, reason: "unknown_zip" };
    }
    const label = args.label.trim().slice(0, 60) || "My search";
    const radius = Math.min(100, Math.max(1, args.radiusMiles ?? 25));
    const mustHaves = (args.mustHaves ?? [])
      .map((m) => m.trim().slice(0, 60))
      .filter(Boolean)
      .slice(0, 8);
    const budgetMax =
      args.budgetMax !== undefined &&
      Number.isFinite(args.budgetMax) &&
      args.budgetMax > 0
        ? Math.min(Math.round(args.budgetMax), 1_000_000)
        : undefined;

    const near: NearbyResult = await ctx.runQuery(api.geo.facilitiesNearZip, {
      zip,
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

    // Counted once the ZIP has resolved, so a mistyped code never uses a try.
    // A campaign opens an inbox, pays Firecrawl for up to twelve lookups, and
    // sends real mail, so it is bounded per visitor and for everyone at once.
    const budget = await allow(ctx, userId, [
      { name: "campaignPerUser", perUser: true },
      { name: "campaignGlobal" },
      { name: "campaignDaily" },
    ]);
    if (!budget.ok) {
      throw new ConvexError(busyMessage("searches", budget.retryAfter));
    }

    const created: { searchId: Id<"searches"> } = await ctx.runAction(
      internal.searches.createSearch,
      {
        userId,
        label,
        zip,
        radiusMiles: radius,
        careLevel: args.careLevel,
        budgetMax,
        mustHaves,
        isSample: false,
      },
    );

    const ccns = near.facilities.map((f) => f.ccn);

    // Discovery first, because these facilities have almost certainly never
    // been looked at. CMS publishes a phone number and nothing else, so until
    // Firecrawl has been out on the open web there is no address to write to
    // (CLAUDE.md section 4). Queued rather than awaited — it runs through the
    // bounded enrichment pool while the board is already on screen.
    await ctx.runMutation(internal.enrichment.queueDiscovery, { ccns, userId });

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
export const rebuildSpatialIndex = internalAction({
  args: {},
  returns: v.object({ started: v.boolean() }),
  handler: async (ctx): Promise<{ started: boolean }> => {
    await ctx.scheduler.runAfter(0, internal.geo.indexFacilityPage, {
      cursor: null,
    });
    return { started: true };
  },
});
