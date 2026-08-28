import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";
import { PERSONAS, replyDelayMs, type PersonaKey } from "./lib/personas";
import { careLevelPhrase } from "./lib/questions";
import { demoModeEnabled } from "./lib/sendGuard";
import { demoFacilityInbox, provisionInbox } from "./email";
import { SAMPLE_CCNS } from "./searches";

/**
 * The facility side of a demo conversation.
 *
 * We never email real nursing homes (CLAUDE.md section 7.1). These are
 * understaffed places caring for real, vulnerable people, and they do not get
 * hackathon traffic. So in demo mode every inquiry is addressed to an inbox we
 * control, and the answer that comes back is played by a seeded persona after a
 * randomised twenty to ninety seconds.
 *
 * The persona's reply is handed to `internal.email.ingestInbound` — the exact
 * function AgentMail's inbound webhook calls. There is no second pipeline. What
 * you watch happen on the board during the demo is the production code path
 * reading text it did not write, deciding a question was dodged, and writing
 * back on its own.
 *
 * Every simulated row is labelled on screen, and the address we would have
 * written to is shown beside the label, so nothing here can be mistaken for a
 * real facility having answered.
 */

export const personaForInquiry = internalQuery({
  args: { inquiryId: v.id("inquiries") },
  returns: v.union(v.null(), v.any()),
  handler: async (ctx, { inquiryId }) => {
    const inquiry = await ctx.db.get(inquiryId);
    if (!inquiry) return null;
    const search = await ctx.db.get(inquiry.searchId);
    const seed = await ctx.db
      .query("simulatedFacilities")
      .withIndex("by_search_ccn", (q) =>
        q.eq("searchId", inquiry.searchId).eq("ccn", inquiry.ccn),
      )
      .unique();
    return { inquiry, search, seed };
  },
});

/**
 * Put a persona's reply on the clock.
 *
 * The delay was drawn when the campaign was seeded and lives on the roster row,
 * so a given facility answers at the same moment on every run and the demo is
 * rehearsable. A persona that bounces or stays silent is scheduled for nothing.
 */
export const schedulePersonaReply = internalMutation({
  args: { inquiryId: v.id("inquiries"), round: v.number() },
  returns: v.null(),
  handler: async (ctx, { inquiryId, round }) => {
    if (!demoModeEnabled()) return null;

    const inquiry = await ctx.db.get(inquiryId);
    if (!inquiry?.persona) return null;
    const persona = PERSONAS[inquiry.persona as PersonaKey];
    if (!persona) return null;

    // A dead address answers nothing, ever. The bounce is delivered instead so
    // the row settles rather than spinning.
    if (persona.bounces) {
      await ctx.scheduler.runAfter(6_000, internal.demo.deliverBounce, {
        inquiryId,
      });
      return null;
    }
    if (persona.silent) return null;
    if (round > 1 && !persona.second) return null;

    const seed = await ctx.db
      .query("simulatedFacilities")
      .withIndex("by_search_ccn", (q) =>
        q.eq("searchId", inquiry.searchId).eq("ccn", inquiry.ccn),
      )
      .unique();

    // The follow-up round answers faster — they are already in the thread.
    const delay = round > 1
      ? Math.round((seed?.responseDelayMs ?? replyDelayMs()) / 3)
      : (seed?.responseDelayMs ?? replyDelayMs());

    await ctx.scheduler.runAfter(delay, internal.demo.deliverPersonaReply, {
      inquiryId,
      round,
    });
    return null;
  },
});

/**
 * Hand the persona's text to the real inbound pipeline.
 *
 * Note what this does NOT do: it does not write parsed fields, decide whether
 * a question was dodged, or touch the board. It delivers an email body and
 * stops. Everything after this point is the same code that runs on a real
 * AgentMail webhook.
 */
export const deliverPersonaReply = internalMutation({
  args: { inquiryId: v.id("inquiries"), round: v.number() },
  returns: v.null(),
  handler: async (ctx, { inquiryId, round }) => {
    const inquiry = await ctx.db.get(inquiryId);
    if (!inquiry?.persona) return null;
    const search = await ctx.db.get(inquiry.searchId);
    if (!search) return null;

    const persona = PERSONAS[inquiry.persona as PersonaKey];
    if (!persona) return null;

    const write = round > 1 ? persona.second : persona.first;
    if (!write) return null;

    // Stable per row, so the same facility reads the same way every run.
    const variant = inquiry._id.charCodeAt(inquiry._id.length - 1);
    const reply = write({
      facilityName: inquiry.facilityName,
      careLevelPhrase: careLevelPhrase(search.careLevel),
      variant,
    });
    if (!reply.body.trim()) return null;

    const outbound = await ctx.db
      .query("threadMessages")
      .withIndex("by_inquiry", (q) => q.eq("inquiryId", inquiryId))
      .collect();
    const sent = outbound.filter((m) => m.direction === "outbound");
    const lastOutbound = sent.length ? sent[sent.length - 1] : undefined;

    // One "Re:", however many rounds deep the thread is.
    const base = (lastOutbound?.subject ?? inquiry.facilityName).replace(
      /^(\s*re\s*:\s*)+/i,
      "",
    );

    await ctx.runMutation(internal.email.ingestInbound, {
      inquiryId,
      subject: `Re: ${base}`,
      body: reply.body,
      fromAddress: `${inquiry.facilityName} <${inquiry.toEmail}>`,
      toAddress: search.inboxEmail,
      // Deterministic, so a re-delivery of the same round is deduped by the
      // same at-least-once guard that protects the real webhook.
      messageId: `simulated:${inquiryId}:${round}`,
      threadId: inquiry.threadId,
      simulated: true,
      persona: persona.key,
    });
    return null;
  },
});

/**
 * A dead address. Common, and the board must show it rather than dropping the
 * row: the facility keeps its inspection record and its CMS phone number.
 */
export const deliverBounce = internalMutation({
  args: { inquiryId: v.id("inquiries") },
  returns: v.null(),
  handler: async (ctx, { inquiryId }) => {
    const inquiry = await ctx.db.get(inquiryId);
    if (!inquiry) return null;
    await ctx.db.patch(inquiryId, {
      status: "bounced",
      deliveryStatus: "bounced",
      deliveryError:
        "The address published on the facility's website rejected the message " +
        "(mailbox unavailable).",
    });
    return null;
  },
});

/**
 * The seeded roster for one search, so the simulation is inspectable from the
 * UI rather than only from the code.
 */
export const roster = query({
  args: { searchId: v.id("searches") },
  returns: v.array(
    v.object({
      ccn: v.string(),
      persona: v.string(),
      personaLabel: v.string(),
      inboxId: v.string(),
      responseDelayMs: v.number(),
    }),
  ),
  handler: async (ctx, { searchId }) => {
    const userId = await getAuthUserId(ctx);
    const search = await ctx.db.get(searchId);
    if (!userId || !search || search.userId !== userId) return [];
    const rows = await ctx.db
      .query("simulatedFacilities")
      .withIndex("by_search", (q) => q.eq("searchId", searchId))
      .collect();
    return rows.map((r) => ({
      ccn: r.ccn,
      persona: r.persona,
      personaLabel: PERSONAS[r.persona as PersonaKey]?.label ?? r.persona,
      inboxId: r.inboxId,
      responseDelayMs: r.responseDelayMs,
    }));
  },
});

/**
 * Rehearsal control: replay a campaign from the top without re-provisioning an
 * inbox or spending another CMS pull. The demo mechanism is the one thing that
 * would sink us on camera, so it needs to be runnable fifty times.
 */
export const resetCampaign = mutation({
  args: { searchId: v.id("searches") },
  returns: v.object({ cleared: v.number() }),
  handler: async (ctx, { searchId }) => {
    const userId = await getAuthUserId(ctx);
    const search = await ctx.db.get(searchId);
    if (!userId || !search || search.userId !== userId) {
      throw new Error("not your search");
    }
    const inquiries = await ctx.db
      .query("inquiries")
      .withIndex("by_search", (q) => q.eq("searchId", searchId))
      .collect();
    const messages = await ctx.db
      .query("threadMessages")
      .withIndex("by_search", (q) => q.eq("searchId", searchId))
      .collect();
    const seeds = await ctx.db
      .query("simulatedFacilities")
      .withIndex("by_search", (q) => q.eq("searchId", searchId))
      .collect();

    for (const m of messages) await ctx.db.delete(m._id);
    for (const s of seeds) await ctx.db.delete(s._id);
    for (const i of inquiries) await ctx.db.delete(i._id);
    await ctx.db.patch(searchId, { campaignStartedAt: undefined });
    return { cleared: inquiries.length };
  },
});

/**
 * Rehearsal harness.
 *
 * The demo depends on seeded personas replying on cue, and that is the one
 * mechanism whose failure would kill the money shot on camera. So it has to be
 * runnable from the command line, without a browser and without a signed-in
 * session, as many times as it takes:
 *
 *   npx convex run demo:rehearse '{"userId":"..."}'
 *
 * It builds the same sample search the cold-open button builds, through the
 * same actions, and returns the search id so the run can be watched.
 */
export const rehearse = internalAction({
  args: { userId: v.id("users"), reset: v.optional(v.boolean()) },
  returns: v.object({
    searchId: v.id("searches"),
    queued: v.number(),
    noEmail: v.number(),
  }),
  handler: async (
    ctx,
    { userId, reset },
  ): Promise<{ searchId: Id<"searches">; queued: number; noEmail: number }> => {
    let searchId: Id<"searches"> | null = await ctx.runQuery(
      internal.searches.findSampleSearch,
      { userId },
    );

    if (searchId && reset) {
      await ctx.runMutation(internal.demo.clearCampaign, { searchId });
    }

    if (!searchId) {
      const inbox = await provisionInbox(ctx, {
        purpose: `search:${userId}:rehearsal`,
        username: `ombuds-rehearsal-${userId.slice(-6)}`,
        displayName: "Alvarez family",
      });
      const posture = await ctx.runQuery(api.email.sendingPosture, {});
      searchId = await ctx.runMutation(internal.searches.insertSearch, {
        userId,
        label: "Alvarez",
        zip: "91767",
        radiusMiles: 25,
        careLevel: "assisted",
        budgetMax: 7000,
        mustHaves: ["memory care on site", "private room", "close to Pomona"],
        inboxId: inbox.inboxId,
        inboxEmail: inbox.email,
        inboxMode: inbox.mode,
        demoMode: posture.demoMode,
        isSample: true,
      });
    }

    await ctx.runAction(internal.email.draftLetter, { searchId });
    const facilities = await ctx.runQuery(internal.searches.shortlistFacilities, {
      ccns: SAMPLE_CCNS,
    });
    const demoInbox = await demoFacilityInbox(ctx);
    const result = await ctx.runMutation(internal.searches.queueCampaign, {
      searchId,
      demoInboxId: demoInbox.inboxId,
      demoInboxEmail: demoInbox.email,
      facilities,
    });
    return { searchId, ...result };
  },
});

/** The unauthenticated half of `resetCampaign`, for the rehearsal harness. */
export const clearCampaign = internalMutation({
  args: { searchId: v.id("searches") },
  returns: v.null(),
  handler: async (ctx, { searchId }) => {
    for (const table of ["inquiries", "threadMessages", "simulatedFacilities"] as const) {
      const rows = await ctx.db
        .query(table)
        .withIndex("by_search", (q) => q.eq("searchId", searchId))
        .collect();
      for (const row of rows) await ctx.db.delete(row._id);
    }
    await ctx.db.patch(searchId, { campaignStartedAt: undefined });
    return null;
  },
});

/**
 * A one-line-per-facility view of a rehearsal in progress, for watching a run
 * from the terminal without a browser.
 */
export const snapshot = internalQuery({
  args: { searchId: v.id("searches") },
  returns: v.any(),
  handler: async (ctx, { searchId }) => {
    const rows = await ctx.db
      .query("inquiries")
      .withIndex("by_search", (q) => q.eq("searchId", searchId))
      .collect();
    const counters = {
      contacted: rows.filter((r) => r.status !== "queued" && !r.noEmailFound).length,
      replied: rows.filter((r) =>
        ["replied", "clarifying", "answered"].includes(r.status),
      ).length,
      openings: rows.filter((r) => r.hasOpening === true).length,
      clarifying: rows.filter((r) => r.status === "clarifying").length,
      bounced: rows.filter((r) => r.status === "bounced").length,
    };
    const lines = rows
      .filter((r) => !r.noEmailFound)
      .map((r) => {
        const cost =
          r.monthlyCostLow != null
            ? `$${r.monthlyCostLow}${r.monthlyCostHigh && r.monthlyCostHigh !== r.monthlyCostLow ? `-${r.monthlyCostHigh}` : ""}`
            : "-";
        return [
          r.facilityName.slice(0, 26).padEnd(26),
          (r.persona ?? "-").padEnd(16),
          r.status.padEnd(11),
          `r${r.rounds}`,
          (r.hasOpening === true ? "OPEN" : r.hasOpening === false ? "full" : "-").padEnd(5),
          cost.padEnd(12),
          (r.staffRatioNights ?? "-").padEnd(7),
          r.unanswered.length ? `missing:${r.unanswered.join("/")}` : "",
        ].join(" ");
      });
    return { counters, lines };
  },
});
