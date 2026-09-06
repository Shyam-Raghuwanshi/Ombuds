import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { inquiryPool, provisionInbox, demoFacilityInbox } from "./email";
import { SEND_STAGGER_MS } from "./email";
import { resolveRecipient } from "./lib/sendGuard";
import { PERSONA_ROSTER, PERSONAS, replyDelayMs } from "./lib/personas";
import { QUESTION_LABEL, type QuestionKey } from "./lib/questions";

/**
 * One family's search, and the board they watch fill in.
 *
 * A search owns three things: the shortlist of facilities it is about, the
 * AgentMail inbox its conversations live in, and the campaign that writes to
 * all of them. The board query at the bottom is the product — safety on the
 * left, availability on the right — and it is reactive, so a reply that lands
 * while the family is reading appears without a refresh.
 */

const careLevel = v.union(
  v.literal("independent"),
  v.literal("assisted"),
  v.literal("memory"),
  v.literal("skilled"),
);

/**
 * The judge cold-open (CLAUDE.md section 7.2): twelve real, Medicare-certified
 * facilities within about ten miles of ZIP 91767, with their real inspection
 * records. Nothing here is invented; the only simulated thing in the whole run
 * is who answers the email.
 */
export const SAMPLE_CCNS = [
  "055016", // Mount San Antonio Gardens, Pomona — 5 star
  "055126", // Chino Valley Health Care Center, Pomona — 2 star
  "055247", // Country Oaks Care Center, Pomona — 3 star
  "055282", // Pomona Vista Care Center — 4 star
  "055394", // Claremont Care Center, Pomona — 4 star
  "056431", // Inland Valley Care and Rehabilitation, Pomona — 1 star
  "05A134", // Landmark Medical Center, Pomona — 2 star
  "05A137", // Laurel Park Behavioral Health, Pomona — 3 star
  "555852", // Park Avenue Healthcare & Wellness, Pomona — 1 star
  "055261", // Pilgrim Place Health Services, Claremont — 3 star
  "055344", // Claremont Heights Post Acute — 2 star
  "555085", // Claremont Manor Care Center — 3 star
];

const SAMPLE_LABEL = "Alvarez";

/**
 * A search is one family's private list: where they are looking, what they can
 * afford, and which homes they are considering for their mother. Every entry
 * point that names a searchId proves the caller owns it before returning or
 * changing anything.
 */
async function assertOwnsSearch(
  ctx: { auth: { getUserIdentity: () => Promise<unknown> }; db: { get: (id: Id<"searches">) => Promise<Doc<"searches"> | null> } },
  searchId: Id<"searches">,
): Promise<Doc<"searches"> | null> {
  const userId = await getAuthUserId(ctx as never);
  if (!userId) return null;
  const search = await ctx.db.get(searchId);
  if (!search || search.userId !== userId) return null;
  return search;
}

// =============================================================================
// Creating a search
// =============================================================================

export const insertSearch = internalMutation({
  args: {
    userId: v.id("users"),
    label: v.string(),
    zip: v.string(),
    radiusMiles: v.number(),
    careLevel,
    budgetMax: v.optional(v.number()),
    mustHaves: v.array(v.string()),
    inboxId: v.string(),
    inboxEmail: v.string(),
    inboxMode: v.union(v.literal("dedicated"), v.literal("shared")),
    demoMode: v.boolean(),
    isSample: v.boolean(),
  },
  returns: v.id("searches"),
  handler: async (ctx, args) =>
    ctx.db.insert("searches", { ...args, createdAt: Date.now() }),
});

export const findSampleSearch = internalQuery({
  args: { userId: v.id("users") },
  returns: v.union(v.null(), v.id("searches")),
  handler: async (ctx, { userId }) => {
    const rows = await ctx.db
      .query("searches")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    return rows.find((s) => s.isSample)?._id ?? null;
  },
});

/**
 * Provision an inbox and open a search.
 *
 * An action rather than a mutation because the inbox has to exist before the
 * row does: a search without a mailbox is a search that can never ask anyone
 * anything.
 */
export const createSearch = action({
  args: {
    label: v.string(),
    zip: v.string(),
    radiusMiles: v.optional(v.number()),
    careLevel,
    budgetMax: v.optional(v.number()),
    mustHaves: v.optional(v.array(v.string())),
    isSample: v.optional(v.boolean()),
  },
  returns: v.object({
    searchId: v.id("searches"),
    inboxEmail: v.string(),
    inboxMode: v.string(),
  }),
  handler: async (ctx, args): Promise<{
    searchId: Id<"searches">;
    inboxEmail: string;
    inboxMode: string;
  }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("not signed in");

    // One inbox per search. The purpose key is per-user-and-label rather than
    // per-search-id, because the search row does not exist yet and a re-run of
    // the same search should reuse the mailbox it already has.
    const slug = args.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 20);
    const inbox = await provisionInbox(ctx, {
      purpose: `search:${userId}:${slug}`,
      username: `ombuds-${slug}-${userId.slice(-6)}`,
      displayName: `${args.label} family`,
    });

    const demo = await ctx.runQuery(api.email.sendingPosture, {});
    const searchId: Id<"searches"> = await ctx.runMutation(
      internal.searches.insertSearch,
      {
        userId,
        label: args.label,
        zip: args.zip,
        radiusMiles: args.radiusMiles ?? 25,
        careLevel: args.careLevel,
        budgetMax: args.budgetMax,
        mustHaves: args.mustHaves ?? [],
        inboxId: inbox.inboxId,
        inboxEmail: inbox.email,
        inboxMode: inbox.mode,
        demoMode: demo.demoMode,
        isSample: args.isSample ?? false,
      },
    );

    return { searchId, inboxEmail: inbox.email, inboxMode: inbox.mode };
  },
});

// =============================================================================
// The fan-out
// =============================================================================

export const shortlistFacilities = internalQuery({
  args: { ccns: v.array(v.string()) },
  returns: v.array(v.any()),
  handler: async (ctx, { ccns }) => {
    const out = [];
    for (const ccn of ccns) {
      const facility = await ctx.db
        .query("facilities")
        .withIndex("by_ccn", (q) => q.eq("ccn", ccn))
        .unique();
      if (facility) out.push(facility);
    }
    return out;
  },
});

/**
 * Create the inquiry rows and hand them to the pool.
 *
 * Every recipient on the board is decided here, once, by the send guard — and
 * in demo mode the guard routes all of them to an inbox we own. A facility with
 * no address found keeps its row: it shows its inspection record and its CMS
 * phone number, because hiding it would reproduce exactly the filtering this
 * product exists to undo (CLAUDE.md section 4).
 */
export const queueCampaign = internalMutation({
  args: {
    searchId: v.id("searches"),
    demoInboxId: v.string(),
    demoInboxEmail: v.string(),
    facilities: v.array(v.any()),
  },
  returns: v.object({ queued: v.number(), noEmail: v.number() }),
  handler: async (ctx, args) => {
    const search = await ctx.db.get(args.searchId);
    if (!search) throw new Error("search not found");

    const existing = await ctx.db
      .query("inquiries")
      .withIndex("by_search", (q) => q.eq("searchId", args.searchId))
      .collect();
    const already = new Set(existing.map((i) => i.ccn));

    let queued = 0;
    let noEmail = 0;
    let personaIndex = 0;

    for (const facility of args.facilities as Doc<"facilities">[]) {
      if (already.has(facility.ccn)) continue;

      const recipient = resolveRecipient({
        facilityEmail: facility.contactEmail ?? null,
        demoInboxEmail: args.demoInboxEmail,
      });

      // Firecrawl found no published address for this facility. That is an
      // ordinary outcome for roughly a third of homes, and it is a different
      // fact from a bounce: there is nobody to write to, rather than an address
      // that failed. The row stays on the board with its inspection record and
      // its CMS phone number, and the board says which of the two happened.
      const hasEmail = Boolean(facility.contactEmail);
      if (!hasEmail) noEmail += 1;

      const rosterIndex = personaIndex;
      const persona =
        recipient.simulated && hasEmail
          ? PERSONAS[PERSONA_ROSTER[personaIndex++ % PERSONA_ROSTER.length]]
          : null;

      await ctx.db.insert("inquiries", {
        searchId: args.searchId,
        ccn: facility.ccn,
        facilityName: facility.name,
        toEmail: hasEmail ? recipient.to : "",
        status: hasEmail ? "queued" : "no_response",
        nudgeCount: 0,
        rounds: 0,
        unanswered: [],
        simulated: recipient.simulated && hasEmail,
        persona: persona?.key,
        intendedTo: recipient.intendedTo ?? undefined,
        noEmailFound: !hasEmail,
      });

      if (persona) {
        await ctx.db.insert("simulatedFacilities", {
          searchId: args.searchId,
          ccn: facility.ccn,
          inboxId: args.demoInboxId,
          persona: persona.key,
          responseDelayMs: replyDelayMs(rosterIndex),
        });
      }

      // Only rows we have an address for will be written to. A facility with
      // no address is left alone rather than emailed nowhere.
      //
      // Nothing is handed to the pool here. The sends are dispatched in a
      // second pass, after the letter exists — see `dispatchCampaign`. Writing
      // the rows first is what puts twelve real inspection records on the
      // family's screen about a second after they click, instead of after a
      // model has finished drafting.
      if (hasEmail) queued += 1;
    }

    await ctx.db.patch(args.searchId, { campaignStartedAt: Date.now() });
    return { queued, noEmail };
  },
});

/**
 * Hand the queued rows to the pool, once the letter they carry exists.
 *
 * Split out from `queueCampaign` for the cold open. The rows are written
 * first and appear on the board immediately with their full inspection record;
 * the letter is drafted while the family is already reading them; only then
 * does anything get sent. The stagger is unchanged — twelve conversations
 * start over about fifteen seconds so the board fills in rather than blinking
 * on all at once.
 */
export const dispatchCampaign = internalMutation({
  args: { searchId: v.id("searches") },
  returns: v.object({ dispatched: v.number() }),
  handler: async (ctx, { searchId }) => {
    const queued = await ctx.db
      .query("inquiries")
      .withIndex("by_search_status", (q) =>
        q.eq("searchId", searchId).eq("status", "queued"),
      )
      .collect();

    let dispatched = 0;
    for (const inquiry of queued) {
      await inquiryPool.enqueueAction(
        ctx,
        internal.email.sendInquiryWorker,
        { inquiryId: inquiry._id },
        { runAfter: dispatched * SEND_STAGGER_MS },
      );
      dispatched += 1;
    }
    return { dispatched };
  },
});

/**
 * Queue one more facility onto a campaign that already exists.
 *
 * The single-facility form of `queueCampaign`, and it shares its rules: the
 * send guard decides the recipient, a facility with no discovered address keeps
 * its row rather than being dropped, and a facility already on the shortlist is
 * a no-op rather than a second letter.
 *
 * Its persona is drawn from where the roster has got to on this search, so a
 * facility added mid-campaign behaves like the others rather than always being
 * the same one.
 */
export const queueOneFacility = internalMutation({
  args: {
    searchId: v.id("searches"),
    ccn: v.string(),
    demoInboxId: v.string(),
    demoInboxEmail: v.string(),
  },
  returns: v.object({
    queued: v.boolean(),
    reason: v.string(),
    facilityName: v.optional(v.string()),
    inquiryId: v.optional(v.id("inquiries")),
  }),
  handler: async (ctx, args) => {
    const search = await ctx.db.get(args.searchId);
    if (!search) return { queued: false, reason: "no_such_search" };

    const facility = await ctx.db
      .query("facilities")
      .withIndex("by_ccn", (q) => q.eq("ccn", args.ccn))
      .unique();
    if (!facility) {
      // We do not invent a facility to write to. If CMS has never been asked
      // for this CCN, the honest answer is that we do not know this place.
      return { queued: false, reason: "facility_not_ingested" };
    }

    const existing = await ctx.db
      .query("inquiries")
      .withIndex("by_search", (q) => q.eq("searchId", args.searchId))
      .collect();
    const already = existing.find((i) => i.ccn === args.ccn);
    if (already) {
      return {
        queued: false,
        reason: "already_on_this_shortlist",
        facilityName: facility.name,
        inquiryId: already._id,
      };
    }

    const recipient = resolveRecipient({
      facilityEmail: facility.contactEmail ?? null,
      demoInboxEmail: args.demoInboxEmail,
    });
    const hasEmail = Boolean(facility.contactEmail);
    const persona =
      recipient.simulated && hasEmail
        ? PERSONAS[PERSONA_ROSTER[existing.length % PERSONA_ROSTER.length]]
        : null;

    const inquiryId = await ctx.db.insert("inquiries", {
      searchId: args.searchId,
      ccn: facility.ccn,
      facilityName: facility.name,
      toEmail: hasEmail ? recipient.to : "",
      status: hasEmail ? "queued" : "no_response",
      nudgeCount: 0,
      rounds: 0,
      unanswered: [],
      simulated: recipient.simulated && hasEmail,
      persona: persona?.key,
      intendedTo: recipient.intendedTo ?? undefined,
      noEmailFound: !hasEmail,
    });

    if (!hasEmail) {
      return {
        queued: false,
        reason: "no_email_address_published",
        facilityName: facility.name,
        inquiryId,
      };
    }

    if (persona) {
      await ctx.db.insert("simulatedFacilities", {
        searchId: args.searchId,
        ccn: facility.ccn,
        inboxId: args.demoInboxId,
        persona: persona.key,
        responseDelayMs: replyDelayMs(existing.length),
      });
    }

    await inquiryPool.enqueueAction(ctx, internal.email.sendInquiryWorker, {
      inquiryId,
    });
    return {
      queued: true,
      reason: "queued",
      facilityName: facility.name,
      inquiryId,
    };
  },
});

/**
 * Write to every facility on the shortlist.
 *
 * Drafts the family's letter once, then fans out through the bounded pool with
 * a stagger, so twelve conversations start over about fifteen seconds rather
 * than all in the same instant.
 */
/**
 * The campaign, in the order that puts something real on screen soonest.
 *
 *   1. Write the rows.    The board fills with twelve facilities and their
 *                         federal inspection records — no model involved, so
 *                         this lands about a second after the click.
 *   2. Draft the letter.  One model call, while the family is already reading.
 *   3. Dispatch.          Staggered through the bounded pool.
 *
 * The old order drafted first, which meant the judge watched a spinner for the
 * length of a model call before seeing anything at all. Same work, same cost,
 * and the sixty-second budget in CLAUDE.md section 7.2 is spent on the product
 * rather than on waiting.
 */
export const runCampaign = internalAction({
  args: { searchId: v.id("searches"), ccns: v.array(v.string()) },
  returns: v.object({ queued: v.number(), noEmail: v.number() }),
  handler: async (ctx, { searchId, ccns }): Promise<{ queued: number; noEmail: number }> => {
    const facilities = await ctx.runQuery(internal.searches.shortlistFacilities, {
      ccns,
    });
    const demoInbox = await demoFacilityInbox(ctx);
    const result: { queued: number; noEmail: number } = await ctx.runMutation(
      internal.searches.queueCampaign,
      {
        searchId,
        demoInboxId: demoInbox.inboxId,
        demoInboxEmail: demoInbox.email,
        facilities,
      },
    );

    // The draft is bounded and writes a canonical letter if the model does not
    // answer, so it should not throw. It is caught anyway: the rows are already
    // on the family's screen at this point, and a campaign stranded at "queued"
    // with no letter and no explanation is the worst state this product has.
    // Dispatching regardless means the worst case is an unpersonalised letter
    // rather than twelve conversations that never start.
    try {
      await ctx.runAction(internal.email.draftLetter, { searchId });
    } catch (error) {
      console.error(`[searches] letter draft failed for ${searchId}: ${error}`);
      await ctx.runMutation(internal.email.ensureCanonicalDraft, { searchId });
    }

    await ctx.runMutation(internal.searches.dispatchCampaign, { searchId });
    return result;
  },
});

export const startCampaign = action({
  args: { searchId: v.id("searches"), ccns: v.array(v.string()) },
  returns: v.object({ queued: v.number(), noEmail: v.number() }),
  handler: async (ctx, { searchId, ccns }): Promise<{ queued: number; noEmail: number }> => {
    const owned: boolean = await ctx.runQuery(api.searches.ownsSearch, { searchId });
    if (!owned) throw new Error("not your search");
    return ctx.runAction(internal.searches.runCampaign, { searchId, ccns });
  },
});

/**
 * The judge's front door.
 *
 * One click, no form, no account: anonymous auth has already signed them in, a
 * pre-seeded search for a real ZIP loads with real federal inspection records,
 * and the campaign fires live. Reused rather than recreated on a second click,
 * so refreshing the page does not start twelve more conversations.
 */
export const runSampleSearch = action({
  args: {},
  returns: v.object({ searchId: v.id("searches"), started: v.boolean() }),
  handler: async (ctx): Promise<{ searchId: Id<"searches">; started: boolean }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("not signed in");

    const existing: Id<"searches"> | null = await ctx.runQuery(
      internal.searches.findSampleSearch,
      { userId },
    );
    if (existing) return { searchId: existing, started: false };

    const created: { searchId: Id<"searches"> } = await ctx.runAction(
      api.searches.createSearch,
      {
        label: SAMPLE_LABEL,
        zip: "91767",
        radiusMiles: 25,
        careLevel: "assisted",
        budgetMax: 7000,
        mustHaves: ["memory care on site", "private room", "close to Pomona"],
        isSample: true,
      },
    );

    // Handed to the scheduler rather than awaited. The judge's click returns
    // as soon as the search exists — the board is on screen while the rows,
    // the letter, and the fan-out are still being written behind it. Awaiting
    // this here would have spent the first ten seconds of a sixty-second cold
    // open on a disabled button (CLAUDE.md section 7.2).
    await ctx.scheduler.runAfter(0, internal.searches.runCampaign, {
      searchId: created.searchId,
      ccns: SAMPLE_CCNS,
    });
    return { searchId: created.searchId, started: true };
  },
});

/** Ownership, as a query, so actions can check it before doing any work. */
export const ownsSearch = query({
  args: { searchId: v.id("searches") },
  returns: v.boolean(),
  handler: async (ctx, { searchId }) =>
    (await assertOwnsSearch(ctx, searchId)) !== null,
});

// =============================================================================
// The board
// =============================================================================

const boardRow = v.object({
  inquiryId: v.id("inquiries"),
  ccn: v.string(),
  facilityName: v.string(),
  city: v.string(),
  state: v.string(),
  phone: v.string(),
  // Safety — the federal record, and the date it was inspected
  overallRating: v.number(),
  abuseIcon: v.boolean(),
  actualHarm: v.number(),
  immediateJeopardy: v.number(),
  latestSurveyDate: v.number(),
  // Availability — what the facility told us, and when
  status: v.string(),
  deliveryStatus: v.union(v.string(), v.null()),
  // How many times we have written to them. Two means the agent read a reply,
  // decided the family was still owed an answer, and asked again on its own.
  rounds: v.number(),
  followUpReason: v.union(v.string(), v.null()),
  nudgeCount: v.number(),
  // Set once what they told us is more than thirty days old.
  stale: v.boolean(),
  answeredAt: v.union(v.number(), v.null()),
  // The federal staffing figure, so the facility's own claim about who is on
  // the floor at 3am can be read next to what CMS publishes for that building.
  // Null means CMS published no figure — never zero.
  rnHoursWeekend: v.union(v.number(), v.null()),
  specialFocusStatus: v.union(v.string(), v.null()),
  hasOpening: v.union(v.boolean(), v.null()),
  monthlyCostLow: v.union(v.number(), v.null()),
  monthlyCostHigh: v.union(v.number(), v.null()),
  oneTimeFee: v.union(v.number(), v.null()),
  waitlistWeeks: v.union(v.number(), v.null()),
  tourOffered: v.union(v.boolean(), v.null()),
  staffRatioNights: v.union(v.string(), v.null()),
  confidence: v.union(v.number(), v.null()),
  unanswered: v.array(v.string()),
  unansweredLabels: v.array(v.string()),
  replySummary: v.union(v.string(), v.null()),
  lastInboundAt: v.union(v.number(), v.null()),
  // Provenance
  simulated: v.boolean(),
  persona: v.union(v.string(), v.null()),
  personaLabel: v.union(v.string(), v.null()),
  toEmail: v.string(),
  intendedTo: v.union(v.string(), v.null()),
  noEmailFound: v.boolean(),
});

/**
 * The board. Safety on the left, availability on the right, and a counter at
 * the top that moves while you watch it.
 *
 * The two halves come from different worlds and must never be blurred: the
 * left is the federal inspection record with the date it was inspected, and
 * the right is what a facility said about itself in an email, with the date it
 * said it. Both carry their provenance into the row so the UI cannot present
 * one as the other (CLAUDE.md section 8).
 */
export const board = query({
  args: { searchId: v.id("searches") },
  returns: v.union(
    v.null(),
    v.object({
      search: v.object({
        label: v.string(),
        zip: v.string(),
        careLevel: v.string(),
        budgetMax: v.union(v.number(), v.null()),
        mustHaves: v.array(v.string()),
        inboxEmail: v.string(),
        inboxMode: v.string(),
        demoMode: v.boolean(),
        campaignStartedAt: v.union(v.number(), v.null()),
        letterModel: v.union(v.string(), v.null()),
      }),
      counters: v.object({
        shortlisted: v.number(),
        contacted: v.number(),
        replied: v.number(),
        openings: v.number(),
        flagged: v.number(),
        bounced: v.number(),
        awaiting: v.number(),
        clarifying: v.number(),
        // Conversations the agent took to a second round on its own.
        followedUp: v.number(),
        nudged: v.number(),
      }),
      // Harm-level citations that appeared in the federal record AFTER this
      // family shortlisted the facility. Raised by the monthly CMS refresh.
      alerts: v.array(
        v.object({
          id: v.id("facilityAlerts"),
          ccn: v.string(),
          facilityName: v.string(),
          kind: v.string(),
          tag: v.string(),
          tagDescription: v.string(),
          scopeSeverity: v.string(),
          surveyDate: v.number(),
          detectedAt: v.number(),
        }),
      ),
      rows: v.array(boardRow),
    }),
  ),
  handler: async (ctx, { searchId }) => {
    const search = await assertOwnsSearch(ctx, searchId);
    if (!search) return null;

    const inquiries = await ctx.db
      .query("inquiries")
      .withIndex("by_search", (q) => q.eq("searchId", searchId))
      .collect();
    const alerts = await ctx.db
      .query("facilityAlerts")
      .withIndex("by_search", (q) => q.eq("searchId", searchId))
      .collect();

    const rows = [];
    for (const inquiry of inquiries) {
      const facility = await ctx.db
        .query("facilities")
        .withIndex("by_ccn", (q) => q.eq("ccn", inquiry.ccn))
        .unique();

      // Harm counts come off the (ccn, harmLevel) index rather than a scan, so
      // a twelve-row board is twenty-four indexed reads and no filtering.
      const harm = await ctx.db
        .query("deficiencies")
        .withIndex("by_ccn_harm", (q) =>
          q.eq("ccn", inquiry.ccn).eq("harmLevel", "actual_harm"),
        )
        .collect();
      const jeopardy = await ctx.db
        .query("deficiencies")
        .withIndex("by_ccn_harm", (q) =>
          q.eq("ccn", inquiry.ccn).eq("harmLevel", "immediate_jeopardy"),
        )
        .collect();
      const latestSurveyDate = Math.max(
        0,
        ...harm.map((d) => d.surveyDate),
        ...jeopardy.map((d) => d.surveyDate),
      );

      const persona = inquiry.persona
        ? PERSONAS[inquiry.persona as keyof typeof PERSONAS]
        : null;

      rows.push({
        inquiryId: inquiry._id,
        ccn: inquiry.ccn,
        facilityName: inquiry.facilityName,
        city: facility?.city ?? "",
        state: facility?.state ?? "",
        phone: facility?.phone ?? "",
        overallRating: facility?.overallRating ?? 0,
        abuseIcon: facility?.abuseIcon ?? false,
        actualHarm: harm.length,
        immediateJeopardy: jeopardy.length,
        latestSurveyDate,
        status: inquiry.status,
        deliveryStatus: inquiry.deliveryStatus ?? null,
        rounds: inquiry.rounds,
        followUpReason: inquiry.followUpReason ?? null,
        nudgeCount: inquiry.nudgeCount,
        stale: inquiry.staleAt !== undefined,
        answeredAt: inquiry.answeredAt ?? null,
        rnHoursWeekend: facility?.rnHoursWeekend ?? null,
        specialFocusStatus: facility?.specialFocusStatus ?? null,
        hasOpening: inquiry.hasOpening ?? null,
        monthlyCostLow: inquiry.monthlyCostLow ?? null,
        monthlyCostHigh: inquiry.monthlyCostHigh ?? null,
        oneTimeFee: inquiry.oneTimeFee ?? null,
        waitlistWeeks: inquiry.waitlistWeeks ?? null,
        tourOffered: inquiry.tourOffered ?? null,
        staffRatioNights: inquiry.staffRatioNights ?? null,
        confidence: inquiry.confidence ?? null,
        unanswered: inquiry.unanswered,
        unansweredLabels: inquiry.unanswered.map(
          (k) => QUESTION_LABEL[k as QuestionKey] ?? k,
        ),
        replySummary: inquiry.replySummary ?? null,
        lastInboundAt: inquiry.lastInboundAt ?? null,
        simulated: inquiry.simulated,
        persona: inquiry.persona ?? null,
        personaLabel: persona?.label ?? null,
        toEmail: inquiry.toEmail,
        intendedTo: inquiry.intendedTo ?? null,
        noEmailFound: inquiry.noEmailFound ?? false,
      });
    }

    // Worst inspection record last: a family scanning down the page should meet
    // the places that hurt someone, not have to hunt for them.
    rows.sort((a, b) => {
      const openingRank = (r: typeof a) => (r.hasOpening === true ? 0 : 1);
      if (openingRank(a) !== openingRank(b)) return openingRank(a) - openingRank(b);
      const harmRank = (r: typeof a) => r.immediateJeopardy * 10 + r.actualHarm;
      if (harmRank(a) !== harmRank(b)) return harmRank(a) - harmRank(b);
      return b.overallRating - a.overallRating;
    });

    const replied = rows.filter((r) =>
      ["replied", "clarifying", "answered"].includes(r.status),
    ).length;

    return {
      search: {
        label: search.label,
        zip: search.zip,
        careLevel: search.careLevel,
        budgetMax: search.budgetMax ?? null,
        mustHaves: search.mustHaves,
        inboxEmail: search.inboxEmail,
        inboxMode: search.inboxMode,
        demoMode: search.demoMode,
        campaignStartedAt: search.campaignStartedAt ?? null,
        letterModel: search.letterDraft?.model ?? null,
      },
      counters: {
        shortlisted: rows.length,
        // A facility with no published address was never contacted. Counting
        // it would inflate the one number on this screen a family is most
        // likely to take at face value.
        contacted: rows.filter((r) => !r.noEmailFound && r.status !== "queued")
          .length,
        replied,
        openings: rows.filter((r) => r.hasOpening === true).length,
        flagged: rows.filter((r) => r.actualHarm > 0 || r.immediateJeopardy > 0)
          .length,
        bounced: rows.filter((r) => r.status === "bounced").length,
        awaiting: rows.filter((r) =>
          ["queued", "sent", "delivered"].includes(r.status),
        ).length,
        clarifying: rows.filter((r) => r.status === "clarifying").length,
        followedUp: rows.filter((r) => r.rounds > 1).length,
        nudged: rows.filter((r) => r.nudgeCount > 0).length,
      },
      alerts: alerts
        .filter((a) => a.dismissedAt === undefined)
        .sort((a, b) => b.detectedAt - a.detectedAt)
        .map((a) => ({
          id: a._id,
          ccn: a.ccn,
          facilityName: a.facilityName,
          kind: a.kind,
          tag: a.tag,
          tagDescription: a.tagDescription,
          scopeSeverity: a.scopeSeverity,
          surveyDate: a.surveyDate,
          detectedAt: a.detectedAt,
        })),
      rows,
    };
  },
});

/** The signed-in family's searches, newest first. */
export const mySearches = query({
  args: {},
  returns: v.array(
    v.object({
      searchId: v.id("searches"),
      label: v.string(),
      zip: v.string(),
      isSample: v.boolean(),
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const rows = await ctx.db
      .query("searches")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    return rows
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((s) => ({
        searchId: s._id,
        label: s.label,
        zip: s.zip,
        isSample: s.isSample,
        createdAt: s.createdAt,
      }));
  },
});

// =============================================================================
// Facilities whose address arrived late
// =============================================================================

/**
 * Queue the facilities that had no address when the campaign started.
 *
 * The judge cold-open runs against twelve facilities that were enriched days
 * ago, so every address is already known when the fan-out happens. A family
 * searching their own ZIP is the opposite case: their twelve homes have never
 * been looked at, Firecrawl is still out on the open web finding websites, and
 * a campaign that fired immediately would mark all twelve `no_email_found` and
 * settle there — a board with a full safety record and not one conversation.
 *
 * Rather than make the family wait behind discovery, the campaign starts at
 * once and this runs behind it: any inquiry still marked as having no address,
 * whose facility has since acquired one, is upgraded in place and sent. The
 * board fills from the left immediately and from the right as addresses land.
 */
export const backfillDiscoveredEmails = internalMutation({
  args: { searchId: v.id("searches") },
  returns: v.object({ queued: v.number(), stillMissing: v.number() }),
  handler: async (ctx, { searchId }) => {
    const search = await ctx.db.get(searchId);
    if (!search) return { queued: 0, stillMissing: 0 };

    const inquiries = await ctx.db
      .query("inquiries")
      .withIndex("by_search", (q) => q.eq("searchId", searchId))
      .collect();

    const demoInbox = await ctx.db
      .query("agentInboxes")
      .withIndex("by_purpose", (q) => q.eq("purpose", "demo_facilities"))
      .unique();
    if (!demoInbox) return { queued: 0, stillMissing: 0 };

    // Personas are assigned by position so a search always meets the same
    // spread of outcomes — an opening, a waitlist, a dodge, a dead address —
    // regardless of which facilities happened to be reachable.
    let rosterIndex = inquiries.filter((i) => i.simulated).length;
    let queued = 0;
    let stillMissing = 0;

    for (const inquiry of inquiries) {
      if (!inquiry.noEmailFound) continue;

      const facility = await ctx.db
        .query("facilities")
        .withIndex("by_ccn", (q) => q.eq("ccn", inquiry.ccn))
        .unique();
      if (!facility?.contactEmail) {
        stillMissing += 1;
        continue;
      }

      const recipient = resolveRecipient({
        facilityEmail: facility.contactEmail,
        demoInboxEmail: demoInbox.email,
      });
      const persona = recipient.simulated
        ? PERSONAS[PERSONA_ROSTER[rosterIndex % PERSONA_ROSTER.length]]
        : null;

      await ctx.db.patch(inquiry._id, {
        toEmail: recipient.to,
        status: "queued",
        simulated: recipient.simulated,
        persona: persona?.key,
        intendedTo: recipient.intendedTo ?? undefined,
        noEmailFound: false,
      });

      if (persona) {
        await ctx.db.insert("simulatedFacilities", {
          searchId,
          ccn: facility.ccn,
          inboxId: demoInbox.inboxId,
          persona: persona.key,
          responseDelayMs: replyDelayMs(rosterIndex),
        });
        rosterIndex += 1;
      }

      await inquiryPool.enqueueAction(ctx, internal.email.sendInquiryWorker, {
        inquiryId: inquiry._id,
      });
      queued += 1;
    }

    if (queued > 0 || stillMissing > 0) {
      console.log(
        `[searches] backfill for ${searchId}: ${queued} newly reachable, ` +
          `${stillMissing} still with no published address`,
      );
    }
    return { queued, stillMissing };
  },
});
