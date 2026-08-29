import { v } from "convex/values";
import { AgentMail, type OutboundId } from "@agentmail/convex";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Workpool } from "@convex-dev/workpool";
import {
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { components, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { generateStructured } from "./ai/provider";
import {
  FOLLOW_UP_SYSTEM,
  INQUIRY_DRAFT_SYSTEM,
  REPLY_PARSE_SYSTEM,
  followUpDraftSchema,
  inquiryDraftSchema,
  replyParseSchema,
} from "./ai/schemas";
import {
  QUESTION_KEYS,
  QUESTION_LABEL,
  careLevelPhrase,
  tourWindow,
  type QuestionKey,
} from "./lib/questions";
import { assembleLetter, fallbackLetter, normalizeQuestions } from "./lib/letter";
import {
  demoModeEnabled,
  demoRealDelivery,
  liveSendingPermitted,
  resolveRecipient,
} from "./lib/sendGuard";

/**
 * The email campaign.
 *
 * Public records tell a family whether a facility is safe. Only email tells
 * them whether it is available. This file is the second half of that sentence:
 * it provisions an inbox for one family's search, writes to every facility on
 * their shortlist, reads what comes back, and asks again when a facility
 * answers four questions out of five.
 *
 * Two things about the shape of it are worth knowing before reading:
 *
 *  1. Every inbound message — a real webhook from AgentMail, or a seeded
 *     persona in demo mode — enters through `ingestInbound`. There is exactly
 *     one inbound code path, so the demo exercises the production pipeline
 *     rather than a parallel one that might not work on the day.
 *
 *  2. Nothing here decides who to email. `convex/lib/sendGuard.ts` owns that,
 *     and it will not return a real facility's address unless two separate
 *     environment flags are both set (CLAUDE.md section 7.1).
 */

// The component client. `onMessageReceived` is inbound mail; `onEvent` is the
// rest of the lifecycle — delivered, bounced, rejected — which is what moves a
// row from "sent" to "delivered" on the board without polling anything.
const agentmail = new AgentMail(components.agentmail, {
  onMessageReceived: internal.email.onMessageReceived,
  onEvent: internal.email.onDeliveryEvent,
});

// Four at a time. A twelve-facility fan-out finishes inside the minute the
// family is watching, and AgentMail never sees twelve simultaneous sends.
const inquiryPool = new Workpool(components.inquiryPool, { maxParallelism: 4 });

/**
 * The AgentMail component publishes its types against Convex ~1.24, before
 * `ctx.runMutation` grew its options parameter in 1.45. The ctx we hand it is a
 * strict superset of what it uses at runtime, so this bridges a declaration
 * skew rather than hiding a real mismatch. Delete it when the component
 * republishes against a current Convex.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const amCtx = (ctx: unknown): any => ctx;

/** How many rounds we are willing to have. One follow-up, then we stop. */
const MAX_ROUNDS = 2;

/**
 * Below this, a reply that technically contained numbers is not something we
 * are willing to put on a board a family will plan around.
 *
 * "Somewhere in the six thousands, I'd have to check" parses. It parses to a
 * number. It is not an answer, and the difference between it and "$6,200" is
 * the difference between a family budgeting correctly and a family being
 * surprised at signing. So low confidence earns a second round of its own,
 * even when every one of the five slots came back filled.
 */
const LOW_CONFIDENCE = 0.6;

/**
 * How long a letter goes unanswered before the single nudge.
 *
 * Seventy-two hours in production. Overridable because the demo has to be
 * rehearsable inside a minute and the nudge is part of what there is to show —
 * see the risk register in CLAUDE.md: this mechanism gets tested fifty times.
 */
function nudgeAfterMs(): number {
  const raw = Number(process.env.OMBUDS_NUDGE_AFTER_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 72 * 60 * 60 * 1000;
}

/**
 * How long a facility's answers stay current.
 *
 * Openings close and waitlists move. A four-month-old "we have a room now" is
 * not a fact, and showing it as one is the single most damaging thing a board
 * like this could do to a family who then drives an hour to see it.
 */
function staleAfterMs(): number {
  const raw = Number(process.env.OMBUDS_STALE_AFTER_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30 * 24 * 60 * 60 * 1000;
}

/**
 * The message to thread a reply onto.
 *
 * In demo mode the inbound half of a conversation is played by a persona and
 * carries a synthetic id (`simulated:<inquiry>:<round>`) so the at-least-once
 * webhook guard can dedupe it. AgentMail has never seen that id and cannot
 * reply to it. Our own outbound letter, on the other hand, is a real AgentMail
 * message with a real id — so that is what the follow-up threads onto, and the
 * conversation stays one thread in the inbox rather than becoming two.
 */
function threadAnchor(
  inboundMessageId: string | undefined,
  outboundMessageId: string | undefined,
): string | undefined {
  const realInbound =
    inboundMessageId && !inboundMessageId.startsWith("simulated:")
      ? inboundMessageId
      : undefined;
  return realInbound ?? outboundMessageId;
}

/** Sends are staggered so the board fills in rather than blinking on at once. */
const SEND_STAGGER_MS = 1_200;

/**
 * How long we will wait for a model to write the family's letter before
 * sending the canonical one instead.
 *
 * Nothing else in the campaign can start until this returns — twelve
 * facilities are waiting on one letter — so it is the single point where a
 * slow or rate-limited provider could eat the whole sixty-second cold open
 * (CLAUDE.md section 7.2). Twelve seconds is long enough for a normal call and
 * short enough that a bad one costs a fraction of the budget. The canonical
 * letter asks the same five questions; it is simply not personalised, and the
 * thread view says so by naming `canonical-fallback` as its author.
 */
const LETTER_DRAFT_DEADLINE_MS = 12_000;

/** How long we keep asking the component what happened to an outbound message. */
const RECONCILE_DELAYS_MS = [2_000, 6_000, 15_000, 40_000];

// =============================================================================
// Inbox provisioning — one inbox per search
// =============================================================================

/**
 * The address every simulated facility answers from, and the address demo mail
 * is routed to. Falls back to the org inbox, which is the only one this
 * deployment's AgentMail credential is permitted to use.
 */
function fallbackInboxEmail(): string {
  const email = process.env.AGENTMAIL_EMAIL;
  if (!email) {
    throw new Error(
      "AGENTMAIL_EMAIL is not set on this deployment. It is the inbox demo " +
        "mail is routed to, and the fallback when a per-search inbox cannot " +
        "be provisioned. Set it with: npx convex env set AGENTMAIL_EMAIL ...",
    );
  }
  return email;
}

export const getInboxByPurpose = internalQuery({
  args: { purpose: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      inboxId: v.string(),
      email: v.string(),
      mode: v.union(v.literal("dedicated"), v.literal("shared")),
    }),
  ),
  handler: async (ctx, { purpose }) => {
    const row = await ctx.db
      .query("agentInboxes")
      .withIndex("by_purpose", (q) => q.eq("purpose", purpose))
      .unique();
    return row
      ? { inboxId: row.inboxId, email: row.email, mode: row.mode }
      : null;
  },
});

export const rememberInbox = internalMutation({
  args: {
    purpose: v.string(),
    inboxId: v.string(),
    email: v.string(),
    mode: v.union(v.literal("dedicated"), v.literal("shared")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("agentInboxes")
      .withIndex("by_purpose", (q) => q.eq("purpose", args.purpose))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        inboxId: args.inboxId,
        email: args.email,
        mode: args.mode,
      });
      return null;
    }
    await ctx.db.insert("agentInboxes", { ...args, createdAt: Date.now() });
    return null;
  },
});

export type ProvisionedInbox = {
  inboxId: string;
  email: string;
  mode: "dedicated" | "shared";
};

/**
 * Provision an AgentMail inbox for one purpose, reusing it on a re-run.
 *
 * The intended architecture is one inbox per family search: a search's threads
 * live in their own mailbox, which is what makes twelve parallel conversations
 * legible instead of one enormous inbox. Whether we get one depends on the
 * AgentMail plan the deployment's credential belongs to, and a credential
 * without `inbox_create` is a normal state of the world rather than a bug.
 *
 * So: ask for a dedicated inbox, and if the answer is no, fall back to the org
 * inbox, label every thread with the search id, and record `mode: "shared"` so
 * the UI can say plainly which one this search got. Nothing pretends.
 */
export async function provisionInbox(
  ctx: ActionCtx,
  args: { purpose: string; username: string; displayName: string },
): Promise<ProvisionedInbox> {
  const existing = await ctx.runQuery(internal.email.getInboxByPurpose, {
    purpose: args.purpose,
  });
  if (existing) return existing;

  let provisioned: ProvisionedInbox;
  try {
    const inbox = await agentmail.createInbox(amCtx(ctx), {
      username: args.username,
      displayName: args.displayName,
      clientId: args.purpose,
    });
    provisioned = {
      inboxId: inbox.inbox_id,
      email: inbox.email,
      mode: "dedicated",
    };
  } catch (error) {
    // Quota, permission, or a username collision. All of them mean the same
    // thing operationally: this search shares the org inbox and says so.
    console.warn(
      `[email] dedicated inbox for ${args.purpose} unavailable, ` +
        `falling back to the shared inbox: ${String(error).slice(0, 200)}`,
    );
    const email = fallbackInboxEmail();
    provisioned = { inboxId: email, email, mode: "shared" };
  }

  await ctx.runMutation(internal.email.rememberInbox, {
    purpose: args.purpose,
    ...provisioned,
  });
  return provisioned;
}

/** The inbox every simulated facility replies from. Provisioned once, reused. */
export async function demoFacilityInbox(ctx: ActionCtx): Promise<ProvisionedInbox> {
  return provisionInbox(ctx, {
    purpose: "demo_facilities",
    username: "ombuds-facilities",
    displayName: "Ombuds demo facilities",
  });
}

// =============================================================================
// Drafting the letter
// =============================================================================

export const searchForDraft = internalQuery({
  args: { searchId: v.id("searches") },
  returns: v.union(v.null(), v.any()),
  handler: async (ctx, { searchId }) => ctx.db.get(searchId),
});

export const saveLetterDraft = internalMutation({
  args: {
    searchId: v.id("searches"),
    subject: v.string(),
    opening: v.string(),
    questions: v.array(v.object({ key: v.string(), text: v.string() })),
    closing: v.string(),
    model: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { searchId, ...draft }) => {
    await ctx.db.patch(searchId, {
      letterDraft: { ...draft, draftedAt: Date.now() },
    });
    return null;
  },
});

/**
 * Guarantee this search has a letter, without calling anything.
 *
 * The backstop for the campaign: if the drafting action died outright rather
 * than falling back — killed mid-flight, or the search vanished under it — the
 * inquiry rows are already on the family's screen and the send worker refuses
 * to run without a draft, so the whole campaign would sit at "queued" with
 * nothing to explain it. This writes the canonical letter and lets the sends
 * proceed. It never overwrites a real draft.
 */
export const ensureCanonicalDraft = internalMutation({
  args: { searchId: v.id("searches") },
  returns: v.object({ wrote: v.boolean() }),
  handler: async (ctx, { searchId }) => {
    const search = await ctx.db.get(searchId);
    if (!search) return { wrote: false };
    if (search.letterDraft) return { wrote: false };

    const fb = fallbackLetter({
      careLevel: search.careLevel,
      tourDates: tourWindow(Date.now()),
      city: `ZIP ${search.zip}`,
      signOff: "",
    });
    await ctx.db.patch(searchId, {
      letterDraft: {
        subject: fb.subject,
        opening: fb.opening,
        questions: fb.questions,
        closing: fb.closing,
        model: "canonical-fallback",
        draftedAt: Date.now(),
      },
    });
    return { wrote: true };
  },
});

/**
 * Write the family's opening letter, once per search.
 *
 * Only the facility's name differs between the twelve copies that go out, so
 * this runs once and is cached on the search. Twelve calls to a large model to
 * produce twelve copies of the same letter would be a waste of the budget we
 * would rather spend translating inspection records (CLAUDE.md section 10).
 *
 * If the model is unreachable we send the canonical letter instead. A family
 * watching an empty board is worse off than a family whose letter was not
 * personalised.
 */
export const draftLetter = internalAction({
  args: { searchId: v.id("searches"), force: v.optional(v.boolean()) },
  returns: v.object({ drafted: v.boolean(), model: v.string() }),
  handler: async (
    ctx,
    { searchId, force },
  ): Promise<{ drafted: boolean; model: string }> => {
    const search: Doc<"searches"> | null = await ctx.runQuery(
      internal.email.searchForDraft,
      { searchId },
    );
    if (!search) throw new Error("search not found");
    // A cached draft is reused — except a fallback one. If the model was
    // unreachable the last time this search ran, we wrote the canonical letter
    // and cached it, and without this check that outage would follow the
    // family forever: every future campaign on this search would keep sending
    // the unpersonalised letter long after the provider recovered. A fallback
    // is a stand-in, not a result, so it is retried.
    const cachedIsFallback = search.letterDraft?.model === "canonical-fallback";
    if (search.letterDraft && !force && !cachedIsFallback) {
      return { drafted: false, model: search.letterDraft.model };
    }

    const tourDates = tourWindow(Date.now());
    const budget = search.budgetMax
      ? `Their budget is up to $${search.budgetMax.toLocaleString()} a month.`
      : "They have not fixed a budget yet and want to know the real number.";
    const mustHaves = search.mustHaves.length
      ? `What matters most to them: ${search.mustHaves.join(", ")}.`
      : "They have not named specific requirements beyond good care.";

    const prompt = [
      `The family is looking for ${careLevelPhrase(search.careLevel)} near ZIP ${search.zip}.`,
      budget,
      mustHaves,
      `Possible tour dates to offer: ${tourDates}.`,
      "",
      "Ask these five things, one question each, in this order:",
      "1. opening  — whether there is an opening right now for this care level",
      "2. cost     — the all-in monthly cost including any care-level surcharges",
      "3. waitlist — how long the waitlist is",
      "4. staffing — the caregiver-to-resident ratio on nights and weekends",
      "5. tour     — whether the family can visit on the dates above",
    ].join("\n");

    let subject: string;
    let opening: string;
    let questions: { key: string; text: string }[];
    let closing: string;
    let model: string;

    try {
      const result = await generateStructured({
        task: "emailDraft",
        system: INQUIRY_DRAFT_SYSTEM,
        prompt,
        schema: inquiryDraftSchema,
        schemaName: "inquiry_draft",
        schemaDescription: "A family's opening letter to a care facility.",
        ctx,
        attribution: { searchId },
        deadlineMs: LETTER_DRAFT_DEADLINE_MS,
      });
      subject = result.object.subject;
      opening = result.object.opening;
      questions = result.object.questions;
      closing = result.object.closing;
      model = result.model;
    } catch (error) {
      console.error(`[email] draft failed, sending canonical letter: ${error}`);
      const fb = fallbackLetter({
        careLevel: search.careLevel,
        tourDates,
        city: `ZIP ${search.zip}`,
        signOff: "",
      });
      subject = fb.subject;
      opening = fb.opening;
      questions = fb.questions;
      closing = fb.closing;
      model = "canonical-fallback";
    }

    await ctx.runMutation(internal.email.saveLetterDraft, {
      searchId,
      subject,
      opening,
      questions,
      closing,
      model,
    });
    return { drafted: true, model };
  },
});

// =============================================================================
// Fan-out
// =============================================================================

export const shortlistForCampaign = internalQuery({
  args: { searchId: v.id("searches") },
  returns: v.array(v.any()),
  handler: async (ctx, { searchId }) =>
    ctx.db
      .query("inquiries")
      .withIndex("by_search", (q) => q.eq("searchId", searchId))
      .collect(),
});

export const inquiryForSend = internalQuery({
  args: { inquiryId: v.id("inquiries") },
  returns: v.union(v.null(), v.any()),
  handler: async (ctx, { inquiryId }) => {
    const inquiry = await ctx.db.get(inquiryId);
    if (!inquiry) return null;
    const search = await ctx.db.get(inquiry.searchId);
    const facility = await ctx.db
      .query("facilities")
      .withIndex("by_ccn", (q) => q.eq("ccn", inquiry.ccn))
      .unique();
    return { inquiry, search, facility };
  },
});

export const markSent = internalMutation({
  args: {
    inquiryId: v.id("inquiries"),
    outboundId: v.optional(v.string()),
    subject: v.string(),
    body: v.string(),
    fromAddress: v.string(),
    toAddress: v.string(),
    model: v.string(),
    round: v.number(),
    status: v.union(v.literal("sent"), v.literal("clarifying")),
    followUpReason: v.optional(
      v.union(v.literal("unanswered"), v.literal("low_confidence")),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const inquiry = await ctx.db.get(args.inquiryId);
    if (!inquiry) return null;

    await ctx.db.patch(args.inquiryId, {
      status: args.status,
      outboundId: args.outboundId,
      sentAt: inquiry.sentAt ?? Date.now(),
      // The counter the family watches move. One per letter we sent them.
      rounds: args.round,
      followUpReason: args.followUpReason ?? inquiry.followUpReason,
    });

    await ctx.db.insert("threadMessages", {
      inquiryId: args.inquiryId,
      searchId: inquiry.searchId,
      direction: "outbound",
      round: args.round,
      subject: args.subject,
      body: args.body,
      fromAddress: args.fromAddress,
      toAddress: args.toAddress,
      threadId: inquiry.threadId,
      simulated: false, // our own letters are always real, even in demo mode
      model: args.model,
      createdAt: Date.now(),
    });

    if (args.outboundId) {
      await ctx.scheduler.runAfter(
        RECONCILE_DELAYS_MS[0],
        internal.email.reconcileOutbound,
        { inquiryId: args.inquiryId, attempt: 0 },
      );
    }
    return null;
  },
});

export const markSendFailed = internalMutation({
  args: { inquiryId: v.id("inquiries"), error: v.string() },
  returns: v.null(),
  handler: async (ctx, { inquiryId, error }) => {
    await ctx.db.patch(inquiryId, {
      status: "bounced",
      deliveryStatus: "failed",
      deliveryError: error.slice(0, 400),
    });
    return null;
  },
});

/**
 * Send one facility its copy of the family's letter.
 *
 * The only thing that varies between copies is the facility's name in the
 * greeting. The address it is sent to is decided by the send guard and nowhere
 * else.
 */
export const sendInquiryWorker = internalAction({
  args: { inquiryId: v.id("inquiries") },
  returns: v.null(),
  handler: async (ctx, { inquiryId }) => {
    const loaded = await ctx.runQuery(internal.email.inquiryForSend, { inquiryId });
    if (!loaded?.inquiry || !loaded.search) return null;
    const { inquiry, search } = loaded as {
      inquiry: Doc<"inquiries">;
      search: Doc<"searches">;
    };
    if (inquiry.status !== "queued") return null; // already sent, or a re-run

    const draft = search.letterDraft;
    if (!draft) throw new Error("letter was not drafted before the fan-out");

    const tourDates = tourWindow(Date.now());
    const { questions } = normalizeQuestions(
      draft.questions,
      search.careLevel,
      tourDates,
    );

    const body = assembleLetter({
      opening: `Hello,\n\n${draft.opening}`,
      questions,
      closing: draft.closing,
      signOff: `Thank you,\nThe ${search.label} family`,
    });
    const subject = `${draft.subject} — ${inquiry.facilityName}`;

    // Nothing below this line chooses a recipient. `inquiry.toEmail` was fixed
    // by the send guard when the campaign was queued.
    let outboundId: string | undefined;
    try {
      if (demoRealDelivery() || !inquiry.simulated) {
        const id = await agentmail.sendMessage(amCtx(ctx), search.inboxId, {
          to: inquiry.toEmail,
          subject,
          text: body,
          // Threads are labelled with the search so that a shared inbox can
          // still be filtered down to one family's campaign.
          labels: [`search:${search._id}`, `ccn:${inquiry.ccn}`],
        });
        outboundId = id as unknown as string;
      }
    } catch (error) {
      await ctx.runMutation(internal.email.markSendFailed, {
        inquiryId,
        error: String(error),
      });
      return null;
    }

    await ctx.runMutation(internal.email.markSent, {
      inquiryId,
      outboundId,
      subject,
      body,
      fromAddress: search.inboxEmail,
      toAddress: inquiry.toEmail,
      model: draft.model,
      round: 1,
      status: "sent",
    });

    // In demo mode the facility side is played from an inbox we control. The
    // reply is scheduled here rather than waiting on a webhook, because the
    // persona is ours (CLAUDE.md section 7.1).
    if (inquiry.simulated) {
      await ctx.runMutation(internal.demo.schedulePersonaReply, {
        inquiryId,
        round: 1,
      });
    }
    return null;
  },
});

/**
 * Add one more facility to a campaign that is already running, and write to it.
 *
 * This exists because a shortlist is not fixed. A family reads one facility's
 * inspection record properly, decides it is worth asking about, and adds it —
 * and the agent has the same affordance, so when a reply says "we are full but
 * the Claremont building may have space", it can look that facility up in the
 * federal record and write to it without a person doing anything.
 *
 * The recipient is resolved by the send guard exactly as it is in the fan-out,
 * so a facility added this way is under the same rule as every other: in demo
 * mode it is routed to an inbox we own, and nothing reaches a real home.
 */
export const sendInquiryToFacility = internalAction({
  args: { searchId: v.id("searches"), ccn: v.string() },
  returns: v.object({
    queued: v.boolean(),
    reason: v.string(),
    facilityName: v.optional(v.string()),
    inquiryId: v.optional(v.id("inquiries")),
  }),
  handler: async (
    ctx,
    { searchId, ccn },
  ): Promise<{
    queued: boolean;
    reason: string;
    facilityName?: string;
    inquiryId?: Id<"inquiries">;
  }> => {
    // The letter is drafted once per search and cached on it; a facility added
    // later gets that same letter rather than paying for a new one.
    await ctx.runAction(internal.email.draftLetter, { searchId });
    const demoInbox = await demoFacilityInbox(ctx);
    return await ctx.runMutation(internal.searches.queueOneFacility, {
      searchId,
      ccn,
      demoInboxId: demoInbox.inboxId,
      demoInboxEmail: demoInbox.email,
    });
  },
});

// =============================================================================
// Delivery lifecycle — the component's own state, mirrored onto the board
// =============================================================================

export const applyDelivery = internalMutation({
  args: {
    inquiryId: v.id("inquiries"),
    deliveryStatus: v.string(),
    threadId: v.optional(v.string()),
    messageId: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const inquiry = await ctx.db.get(args.inquiryId);
    if (!inquiry) return null;

    const patch: Partial<Doc<"inquiries">> = {
      deliveryStatus: args.deliveryStatus,
    };
    if (args.threadId) patch.threadId = args.threadId;
    if (args.messageId) patch.outboundMessageId = args.messageId;
    if (args.error) patch.deliveryError = args.error.slice(0, 400);

    // The delivery lifecycle only ever advances a row that has not yet heard
    // back. Once a facility has replied, "delivered" is old news and must not
    // walk the status backwards.
    const settled = ["replied", "clarifying", "answered"];
    if (!settled.includes(inquiry.status)) {
      if (args.deliveryStatus === "delivered") patch.status = "delivered";
      if (
        args.deliveryStatus === "bounced" ||
        args.deliveryStatus === "failed" ||
        args.deliveryStatus === "rejected"
      ) {
        patch.status = "bounced";
      }
    }
    await ctx.db.patch(args.inquiryId, patch);
    return null;
  },
});

/**
 * Ask the component what happened to an outbound message.
 *
 * This is not a substitute for the webhook — `onDeliveryEvent` below is what
 * actually pushes delivery and bounce state. This exists to learn the thread id
 * as soon as AgentMail assigns one, because the thread id is how an inbound
 * reply is matched back to the inquiry it belongs to. It reads local component
 * state only, so it costs nothing and touches no API.
 */
export const reconcileOutbound = internalMutation({
  args: { inquiryId: v.id("inquiries"), attempt: v.number() },
  returns: v.null(),
  handler: async (ctx, { inquiryId, attempt }) => {
    const inquiry = await ctx.db.get(inquiryId);
    if (!inquiry?.outboundId) return null;

    const status = await agentmail.status(
      amCtx(ctx),
      inquiry.outboundId as OutboundId,
    );
    if (status) {
      await ctx.runMutation(internal.email.applyDelivery, {
        inquiryId,
        deliveryStatus: status.status,
        threadId: status.threadId ?? undefined,
        messageId: status.agentmailMessageId ?? undefined,
        error: status.errorMessage ?? undefined,
      });
      // Once it has left our hands and we know the thread, there is nothing
      // further to learn by asking again.
      if (status.status !== "pending" && status.threadId) return null;
    }

    const next = attempt + 1;
    if (next < RECONCILE_DELAYS_MS.length) {
      await ctx.scheduler.runAfter(
        RECONCILE_DELAYS_MS[next],
        internal.email.reconcileOutbound,
        { inquiryId, attempt: next },
      );
    }
    return null;
  },
});

export const inquiryByOutboundMessage = internalQuery({
  args: { messageId: v.string(), threadId: v.optional(v.string()) },
  returns: v.union(v.null(), v.id("inquiries")),
  handler: async (ctx, { messageId, threadId }) => {
    if (threadId) {
      const byThread = await ctx.db
        .query("inquiries")
        .withIndex("by_thread", (q) => q.eq("threadId", threadId))
        .first();
      if (byThread) return byThread._id;
    }
    const message = await ctx.db
      .query("threadMessages")
      .withIndex("by_message", (q) => q.eq("messageId", messageId))
      .first();
    return message?.inquiryId ?? null;
  },
});

/**
 * Every AgentMail webhook event, not just inbound mail.
 *
 * This is what turns "sent" into "delivered" on the board, and what tells a
 * family plainly that an address bounced rather than leaving a row spinning
 * forever.
 */
export const onDeliveryEvent = internalMutation({
  args: { event: v.any() },
  returns: v.null(),
  handler: async (ctx, { event }) => {
    const map: Record<string, string> = {
      "message.sent": "sent",
      "message.delivered": "delivered",
      "message.bounced": "bounced",
      "message.rejected": "rejected",
      "message.complained": "complained",
    };
    const deliveryStatus = map[event?.event_type];
    if (!deliveryStatus) return null; // message.received is handled elsewhere

    const messageId: string | undefined =
      event?.message?.message_id ?? event?.send?.message_id;
    const threadId: string | undefined =
      event?.message?.thread_id ?? event?.thread?.thread_id;
    if (!messageId && !threadId) return null;

    const inquiryId = await ctx.runQuery(internal.email.inquiryByOutboundMessage, {
      messageId: messageId ?? "",
      threadId,
    });
    if (!inquiryId) return null;

    await ctx.runMutation(internal.email.applyDelivery, {
      inquiryId,
      deliveryStatus,
      threadId,
      messageId,
      error:
        event?.bounce?.diagnostic_code ??
        event?.reject?.reason ??
        undefined,
    });
    return null;
  },
});

// =============================================================================
// Inbound — the one path every reply travels, real or seeded
// =============================================================================

export const resolveInboundInquiry = internalQuery({
  args: {
    threadId: v.optional(v.string()),
    inboxId: v.optional(v.string()),
    subject: v.optional(v.string()),
  },
  returns: v.union(v.null(), v.id("inquiries")),
  handler: async (ctx, { threadId, inboxId, subject }) => {
    // The thread id is the real key, and it is present on every reply to a
    // message we sent.
    if (threadId) {
      const byThread = await ctx.db
        .query("inquiries")
        .withIndex("by_thread", (q) => q.eq("threadId", threadId))
        .first();
      if (byThread) return byThread._id;
    }
    // A reply that arrived before we learned the thread id. The subject we
    // wrote carries the facility's name, and a shared inbox narrows to the
    // searches that use it.
    if (!subject || !inboxId) return null;
    const cleaned = subject.replace(/^\s*(re|fwd)\s*:\s*/i, "").trim();
    const searches = await ctx.db.query("searches").collect();
    for (const search of searches.filter((s) => s.inboxId === inboxId)) {
      const inquiries = await ctx.db
        .query("inquiries")
        .withIndex("by_search", (q) => q.eq("searchId", search._id))
        .collect();
      const match = inquiries.find((i) =>
        cleaned.toLowerCase().includes(i.facilityName.toLowerCase()),
      );
      if (match) return match._id;
    }
    return null;
  },
});

/**
 * Record one inbound message and start reading it.
 *
 * Both a real AgentMail webhook and a seeded persona land here, which is the
 * point: the demo drives the production pipeline. A message we have already
 * stored is ignored, because webhooks are delivered at least once.
 */
export const ingestInbound = internalMutation({
  args: {
    inquiryId: v.id("inquiries"),
    subject: v.string(),
    body: v.string(),
    fromAddress: v.string(),
    toAddress: v.string(),
    messageId: v.optional(v.string()),
    threadId: v.optional(v.string()),
    simulated: v.boolean(),
    persona: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const inquiry = await ctx.db.get(args.inquiryId);
    if (!inquiry) return null;

    if (args.messageId) {
      const seen = await ctx.db
        .query("threadMessages")
        .withIndex("by_message", (q) => q.eq("messageId", args.messageId))
        .first();
      if (seen) return null; // webhooks are at-least-once
    }

    const round = Math.max(inquiry.rounds, 1);
    await ctx.db.insert("threadMessages", {
      inquiryId: args.inquiryId,
      searchId: inquiry.searchId,
      direction: "inbound",
      round,
      subject: args.subject,
      body: args.body,
      fromAddress: args.fromAddress,
      toAddress: args.toAddress,
      messageId: args.messageId,
      threadId: args.threadId ?? inquiry.threadId,
      simulated: args.simulated,
      persona: args.persona,
      createdAt: Date.now(),
    });

    await ctx.db.patch(args.inquiryId, {
      status: "replied",
      lastInboundAt: Date.now(),
      threadId: args.threadId ?? inquiry.threadId,
      // Whatever they just told us is current again.
      staleAt: undefined,
    });

    // Hand the reply to the agent. It reads it, decides whether anything was
    // dodged, and writes back in the same thread if so — all of which needs a
    // model, so none of it can happen inside a mutation.
    await ctx.scheduler.runAfter(0, internal.agentLoop.handleReply, {
      inquiryId: args.inquiryId,
      round,
    });
    return null;
  },
});

/**
 * AgentMail's inbound webhook callback.
 *
 * Everything this does is work out which conversation the message belongs to;
 * the rest is `ingestInbound`, shared with the demo path.
 */
export const onMessageReceived = internalMutation({
  args: { message: v.any(), thread: v.any(), eventId: v.string() },
  returns: v.null(),
  handler: async (ctx, { message }) => {
    const threadId: string | undefined = message?.thread_id;
    const inquiryId = await ctx.runQuery(internal.email.resolveInboundInquiry, {
      threadId,
      inboxId: message?.inbox_id,
      subject: message?.subject,
    });
    if (!inquiryId) {
      console.warn(
        `[email] inbound message ${message?.message_id} on thread ${threadId} ` +
          `does not belong to any inquiry — ignoring`,
      );
      return null;
    }

    const body: string =
      message?.text ?? message?.extracted_text ?? message?.preview ?? "";

    await ctx.runMutation(internal.email.ingestInbound, {
      inquiryId,
      subject: message?.subject ?? "",
      body,
      fromAddress: message?.from ?? "",
      toAddress: Array.isArray(message?.to) ? message.to.join(", ") : "",
      messageId: message?.message_id,
      threadId,
      simulated: false,
    });
    return null;
  },
});

// =============================================================================
// Reading the reply
// =============================================================================

/**
 * What a family is owed is the difference between an answer and a non-answer.
 *
 * The model returns its own `unanswered` list, but the authoritative one is
 * derived here from which fields actually came back with a value. A model that
 * feels confident about a question the email never addressed cannot put a
 * number on the board.
 */
function deriveUnanswered(parsed: {
  hasOpening: boolean | null;
  monthlyCostLow: number | null;
  monthlyCostHigh: number | null;
  waitlistWeeks: number | null;
  tourOffered: boolean | null;
  staffRatioNights: string | null;
  unanswered: string[];
}): QuestionKey[] {
  const missing = new Set<QuestionKey>();
  if (parsed.hasOpening === null) missing.add("opening");
  if (parsed.monthlyCostLow === null && parsed.monthlyCostHigh === null) {
    missing.add("cost");
  }
  if (parsed.waitlistWeeks === null) missing.add("waitlist");
  if (parsed.tourOffered === null) missing.add("tour");
  if (!parsed.staffRatioNights) missing.add("staffing");
  // The model may also have noticed a deflection that produced a value we
  // should not trust. Union, never intersection.
  for (const key of parsed.unanswered) {
    if ((QUESTION_KEYS as readonly string[]).includes(key)) {
      missing.add(key as QuestionKey);
    }
  }
  return QUESTION_KEYS.filter((k) => missing.has(k));
}

export const applyParse = internalMutation({
  args: {
    inquiryId: v.id("inquiries"),
    round: v.number(),
    hasOpening: v.optional(v.boolean()),
    monthlyCostLow: v.optional(v.number()),
    monthlyCostHigh: v.optional(v.number()),
    oneTimeFee: v.optional(v.number()),
    waitlistWeeks: v.optional(v.number()),
    tourOffered: v.optional(v.boolean()),
    staffRatioNights: v.optional(v.string()),
    unanswered: v.array(v.string()),
    confidence: v.number(),
    replySummary: v.string(),
    isAutoReply: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const inquiry = await ctx.db.get(args.inquiryId);
    if (!inquiry) return null;

    // An out-of-office is not an answer. Leave the row waiting.
    if (args.isAutoReply) {
      await ctx.db.patch(args.inquiryId, { replySummary: args.replySummary });
      return null;
    }

    // Later rounds fill gaps; they never overwrite something already answered.
    const keep = <T,>(existing: T | undefined, incoming: T | undefined) =>
      incoming !== undefined ? incoming : existing;

    /**
     * A later round answers what was missing; it does not un-answer what was
     * already given.
     *
     * The parser reads one email at a time, and the reply to a follow-up
     * usually contains only the thing that was asked for again — a single
     * staffing ratio, and nothing about cost or openings. Taken at face value
     * that reads as four fresh dodges, and the board would tell a family that a
     * facility which answered everything had answered almost nothing.
     *
     * So this round's verdict is filtered by what earlier rounds already
     * established. On round one nothing has been established and the filter is
     * a no-op; from round two on it is the difference between a follow-up that
     * closes the gap and one that appears to open four more.
     */
    const answeredBefore = new Set<QuestionKey>();
    if (inquiry.hasOpening !== undefined) answeredBefore.add("opening");
    if (inquiry.monthlyCostLow !== undefined || inquiry.monthlyCostHigh !== undefined) {
      answeredBefore.add("cost");
    }
    if (inquiry.waitlistWeeks !== undefined) answeredBefore.add("waitlist");
    if (inquiry.tourOffered !== undefined) answeredBefore.add("tour");
    if (inquiry.staffRatioNights) answeredBefore.add("staffing");

    const unanswered = args.unanswered.filter(
      (k) => !answeredBefore.has(k as QuestionKey),
    );
    const complete = unanswered.length === 0;
    const exhausted = args.round >= MAX_ROUNDS;
    // A filled-in board is not the goal; a board a family can act on is. A
    // reply the parser was unsure of gets asked again even when every slot came
    // back with something in it.
    const vague = args.confidence < LOW_CONFIDENCE;
    const settled = complete && !vague;

    await ctx.db.patch(args.inquiryId, {
      hasOpening: keep(inquiry.hasOpening, args.hasOpening),
      monthlyCostLow: keep(inquiry.monthlyCostLow, args.monthlyCostLow),
      monthlyCostHigh: keep(inquiry.monthlyCostHigh, args.monthlyCostHigh),
      oneTimeFee: keep(inquiry.oneTimeFee, args.oneTimeFee),
      waitlistWeeks: keep(inquiry.waitlistWeeks, args.waitlistWeeks),
      tourOffered: keep(inquiry.tourOffered, args.tourOffered),
      staffRatioNights: keep(inquiry.staffRatioNights, args.staffRatioNights),
      confidence: args.confidence,
      replySummary: args.replySummary,
      unanswered,
      status: settled || exhausted ? "answered" : "clarifying",
      answeredAt: settled || exhausted ? Date.now() : undefined,
      followUpReason:
        settled || exhausted
          ? inquiry.followUpReason
          : complete
            ? "low_confidence"
            : "unanswered",
      // Fresh again, whatever it said before.
      staleAt: undefined,
    });

    // Nothing is scheduled from here. Deciding whether to write back is the
    // agent's job, and it is holding this conversation open in
    // `convex/agentLoop.ts` — scheduling a send from inside the mutation the
    // agent's own tool just called would race it and produce two letters.
    return null;
  },
});

/** What reading one reply produced. Returned to the agent so it can decide. */
export type ParseOutcome = {
  parsed: boolean;
  reason?: string;
  round: number;
  rounds: number;
  confidence?: number;
  unanswered: string[];
  unansweredLabels: string[];
  replySummary?: string;
  hasOpening?: boolean;
  monthlyCostLow?: number;
  monthlyCostHigh?: number;
  waitlistWeeks?: number;
  tourOffered?: boolean;
  staffRatioNights?: string;
};

export const parseResult = v.object({
  parsed: v.boolean(),
  /** Set when we did not parse: "no_reply", "auto_reply", "parse_failed". */
  reason: v.optional(v.string()),
  round: v.number(),
  rounds: v.number(),
  confidence: v.optional(v.number()),
  unanswered: v.array(v.string()),
  unansweredLabels: v.array(v.string()),
  replySummary: v.optional(v.string()),
  hasOpening: v.optional(v.boolean()),
  monthlyCostLow: v.optional(v.number()),
  monthlyCostHigh: v.optional(v.number()),
  waitlistWeeks: v.optional(v.number()),
  tourOffered: v.optional(v.boolean()),
  staffRatioNights: v.optional(v.string()),
});

export const parseReply = internalAction({
  args: {
    inquiryId: v.id("inquiries"),
    // Both optional: the agent's tool asks for "the latest reply" and this
    // resolves it, while the scheduler path can hand over the exact text it
    // just ingested.
    body: v.optional(v.string()),
    round: v.optional(v.number()),
  },
  returns: parseResult,
  // The return type is written out because this action is called by a tool in
  // `convex/agentLoop.ts`, whose api types are generated from this module — an
  // inference cycle TypeScript will not resolve on its own.
  handler: async (ctx, args): Promise<ParseOutcome> => {
    const { inquiryId } = args;
    const loaded = await ctx.runQuery(internal.email.inquiryForSend, { inquiryId });
    if (!loaded?.inquiry || !loaded.search) {
      return { parsed: false, reason: "no_reply", round: 0, rounds: 0, unanswered: [], unansweredLabels: [] };
    }
    const { inquiry, search } = loaded as {
      inquiry: Doc<"inquiries">;
      search: Doc<"searches">;
    };

    const latest: { body?: string } | null = await ctx.runQuery(
      internal.email.lastInboundFor,
      { inquiryId },
    );
    const body: string = args.body ?? String(latest?.body ?? "");
    const round = args.round ?? Math.max(inquiry.rounds, 1);

    // A bounce notice is not something to spend a model call reading.
    if (!body.trim()) {
      return {
        parsed: false,
        reason: "no_reply",
        round,
        rounds: inquiry.rounds,
        unanswered: inquiry.unanswered,
        unansweredLabels: inquiry.unanswered.map(
          (k) => QUESTION_LABEL[k as QuestionKey] ?? k,
        ),
      };
    }

    const prompt = [
      `The family asked about ${careLevelPhrase(search.careLevel)} at ` +
        `${inquiry.facilityName}.`,
      "",
      "This is the facility's reply, verbatim:",
      "---",
      body.slice(0, 8_000),
      "---",
    ].join("\n");

    let parsed;
    try {
      const result = await generateStructured({
        task: "emailReplyParse",
        system: REPLY_PARSE_SYSTEM,
        prompt,
        schema: replyParseSchema,
        schemaName: "reply_parse",
        schemaDescription: "What one facility's reply actually says.",
        ctx,
        attribution: { searchId: search._id, inquiryId },
      });
      parsed = result.object;
    } catch (error) {
      console.error(`[email] reply parse failed for ${inquiryId}: ${error}`);
      return {
        parsed: false,
        reason: "parse_failed",
        round,
        rounds: inquiry.rounds,
        unanswered: inquiry.unanswered,
        unansweredLabels: inquiry.unanswered.map(
          (k) => QUESTION_LABEL[k as QuestionKey] ?? k,
        ),
      };
    }

    const nn = <T,>(value: T | null): T | undefined =>
      value === null ? undefined : value;

    const unanswered = deriveUnanswered(parsed);

    await ctx.runMutation(internal.email.applyParse, {
      inquiryId,
      round,
      hasOpening: nn(parsed.hasOpening),
      monthlyCostLow: nn(parsed.monthlyCostLow),
      monthlyCostHigh: nn(parsed.monthlyCostHigh),
      oneTimeFee: nn(parsed.oneTimeFee),
      waitlistWeeks: nn(parsed.waitlistWeeks),
      tourOffered: nn(parsed.tourOffered),
      staffRatioNights: nn(parsed.staffRatioNights),
      unanswered,
      confidence: parsed.confidence,
      replySummary: parsed.replySummary,
      isAutoReply: parsed.isAutoReply,
    });

    if (parsed.isAutoReply) {
      return {
        parsed: false,
        reason: "auto_reply",
        round,
        rounds: inquiry.rounds,
        unanswered: inquiry.unanswered,
        unansweredLabels: inquiry.unanswered.map(
          (k) => QUESTION_LABEL[k as QuestionKey] ?? k,
        ),
        replySummary: parsed.replySummary,
      };
    }

    return {
      parsed: true,
      round,
      rounds: inquiry.rounds,
      confidence: parsed.confidence,
      unanswered,
      unansweredLabels: unanswered.map((k) => QUESTION_LABEL[k] ?? k),
      replySummary: parsed.replySummary,
      hasOpening: nn(parsed.hasOpening),
      monthlyCostLow: nn(parsed.monthlyCostLow),
      monthlyCostHigh: nn(parsed.monthlyCostHigh),
      waitlistWeeks: nn(parsed.waitlistWeeks),
      tourOffered: nn(parsed.tourOffered),
      staffRatioNights: nn(parsed.staffRatioNights),
    };
  },
});

// =============================================================================
// The follow-up — in-thread, on its own
// =============================================================================

export const lastInboundFor = internalQuery({
  args: { inquiryId: v.id("inquiries") },
  returns: v.union(v.null(), v.any()),
  handler: async (ctx, { inquiryId }) => {
    const messages = await ctx.db
      .query("threadMessages")
      .withIndex("by_inquiry", (q) => q.eq("inquiryId", inquiryId))
      .collect();
    const inbound = messages.filter((m) => m.direction === "inbound");
    return inbound[inbound.length - 1] ?? null;
  },
});

/**
 * Ask again for exactly what they left out, in the same thread.
 *
 * A single-shot send and receive would leave a permanent blank in the cost
 * column for every facility that said "it depends on her care level", which is
 * most of them. This is the round that turns a deflection into a number.
 */
export const sendFollowUp = internalAction({
  args: {
    inquiryId: v.id("inquiries"),
    round: v.number(),
    reason: v.optional(
      v.union(v.literal("unanswered"), v.literal("low_confidence")),
    ),
  },
  returns: v.object({ sent: v.boolean(), reason: v.string() }),
  handler: async (
    ctx,
    { inquiryId, round, reason },
  ): Promise<{ sent: boolean; reason: string }> => {
    const loaded = await ctx.runQuery(internal.email.inquiryForSend, { inquiryId });
    if (!loaded?.inquiry || !loaded.search) {
      return { sent: false, reason: "no_such_inquiry" };
    }
    const { inquiry, search, facility } = loaded as {
      inquiry: Doc<"inquiries">;
      search: Doc<"searches">;
      facility: Doc<"facilities"> | null;
    };

    // We are not a pest. One follow-up per facility, then we stop, whoever asks
    // and however many times they ask (CLAUDE.md section 4).
    if (round > MAX_ROUNDS) return { sent: false, reason: "round_cap_reached" };
    if (inquiry.status === "bounced" || inquiry.status === "no_response") {
      return { sent: false, reason: `inquiry_is_${inquiry.status}` };
    }

    // Idempotency, and the reason it matters: two things can ask for this round
    // — the agent, having decided a question was dodged, and the reconciliation
    // sweep that runs behind it in case the agent never answered. Both must be
    // able to fire without a facility receiving the same letter twice.
    const alreadySent: boolean = await ctx.runQuery(
      internal.email.outboundExistsForRound,
      { inquiryId, round },
    );
    if (alreadySent) return { sent: false, reason: "already_sent_this_round" };

    const vague =
      inquiry.confidence !== undefined && inquiry.confidence < LOW_CONFIDENCE;
    const why = reason ?? (inquiry.unanswered.length > 0 ? "unanswered" : "low_confidence");

    // Something has to be worth asking for.
    if (inquiry.unanswered.length === 0 && !vague) {
      return { sent: false, reason: "nothing_left_to_ask" };
    }

    const previous = await ctx.runQuery(internal.email.lastInboundFor, { inquiryId });
    const tourDates = tourWindow(Date.now());

    /**
     * What to ask for. Normally the questions they skipped. When they answered
     * all five but hedged every one of them, the two that a family actually
     * plans around — what it costs and who is on the floor at night — are put
     * back to them for a figure they are willing to put in writing.
     */
    const missing: QuestionKey[] =
      inquiry.unanswered.length > 0
        ? (inquiry.unanswered as QuestionKey[])
        : (["cost", "staffing"] as QuestionKey[]);

    const answered = [
      inquiry.hasOpening !== undefined &&
        `they ${inquiry.hasOpening ? "have" : "do not have"} an opening`,
      inquiry.monthlyCostLow !== undefined && "they gave a monthly cost",
      inquiry.waitlistWeeks !== undefined && "they gave the waitlist length",
      inquiry.staffRatioNights && `they gave a night ratio of ${inquiry.staffRatioNights}`,
      inquiry.tourOffered !== undefined &&
        `they ${inquiry.tourOffered ? "offered" : "did not offer"} a tour`,
    ]
      .filter(Boolean)
      .join("; ");

    /**
     * The federal staffing figure, when the question we are re-asking is the
     * staffing one.
     *
     * This is the sharpest thing this product does (CLAUDE.md section 6): a
     * facility tells us one caregiver to twelve at night, and CMS has already
     * published how many registered nurse hours per resident that building
     * actually reports at the weekend. It goes into the prompt only to make the
     * question specific — the letter asks for their number, it never quotes the
     * federal one back at them or accuses anybody of anything.
     */
    const staffingContext =
      missing.includes("staffing") && facility?.rnHoursWeekend !== undefined
        ? `For context only, never to be mentioned in the email: the federal ` +
          `record lists ${facility.rnHoursWeekend} registered nurse hours per ` +
          `resident per day at weekends for this facility. Ask for their ` +
          `overnight ratio as a number so the two can be compared.`
        : "";

    const prompt = [
      `${inquiry.facilityName} replied to the family's email.`,
      `What they DID answer: ${answered || "very little"}.`,
      inquiry.unanswered.length > 0
        ? `What they left out: ${missing.map((k) => QUESTION_LABEL[k]).join(", ")}.`
        : `They answered everything, but hedged: the figures are too vague to ` +
          `plan around. Ask them to confirm ` +
          `${missing.map((k) => QUESTION_LABEL[k].toLowerCase()).join(" and ")} ` +
          `as a specific number they are happy to put in writing.`,
      `Care level: ${careLevelPhrase(search.careLevel)}. Tour dates on offer: ${tourDates}.`,
      staffingContext,
      "",
      "Their reply, verbatim, so the thank-you can name something real:",
      "---",
      String(previous?.body ?? "").slice(0, 4_000),
      "---",
    ]
      .filter(Boolean)
      .join("\n");

    let opening: string;
    let questions: { key: string; text: string }[];
    let closing: string;
    let model: string;
    try {
      const result = await generateStructured({
        task: "emailDraft",
        system: FOLLOW_UP_SYSTEM,
        prompt,
        schema: followUpDraftSchema,
        schemaName: "follow_up_draft",
        schemaDescription: "A short follow-up asking again for what was left out.",
        ctx,
        attribution: { searchId: search._id, inquiryId },
      });
      opening = result.object.opening;
      questions = result.object.questions;
      closing = result.object.closing;
      model = result.model;
    } catch (error) {
      console.error(`[email] follow-up draft failed for ${inquiryId}: ${error}`);
      opening = "Thank you for getting back to me so quickly.";
      questions = [];
      closing = "I appreciate your help.";
      model = "canonical-fallback";
    }

    const { questions: normalized } = normalizeQuestions(
      questions,
      search.careLevel,
      tourDates,
      missing,
    );
    const body = assembleLetter({
      opening,
      questions: normalized,
      closing,
      signOff: `Thank you,\nThe ${search.label} family`,
    });
    const subject = `Re: ${(previous?.subject ?? inquiry.facilityName).replace(
      /^(\s*re\s*:\s*)+/i,
      "",
    )}`;

    let outboundId: string | undefined;
    try {
      const anchor = threadAnchor(previous?.messageId, inquiry.outboundMessageId);
      if ((demoRealDelivery() || !inquiry.simulated) && anchor) {
        // Same thread, so the facility sees one conversation rather than a
        // second cold email.
        const id = await agentmail.replyToMessage(
          amCtx(ctx),
          search.inboxId,
          anchor,
          { text: body, labels: [`search:${search._id}`, `ccn:${inquiry.ccn}`] },
        );
        outboundId = id as unknown as string;
      }
    } catch (error) {
      console.error(`[email] follow-up send failed for ${inquiryId}: ${error}`);
    }

    await ctx.runMutation(internal.email.markSent, {
      inquiryId,
      outboundId,
      subject,
      body,
      fromAddress: search.inboxEmail,
      toAddress: inquiry.toEmail,
      model,
      round,
      status: "clarifying",
      followUpReason: why,
    });

    if (inquiry.simulated) {
      await ctx.runMutation(internal.demo.schedulePersonaReply, { inquiryId, round });
    }
    return { sent: true, reason: why };
  },
});

/**
 * Has a letter already gone out for this round?
 *
 * The idempotency key for the whole follow-up path. Rounds are the unit a
 * facility experiences — one opening letter, one follow-up — so "an outbound
 * message exists at this round number" is exactly the condition that must never
 * be true twice.
 */
export const outboundExistsForRound = internalQuery({
  args: { inquiryId: v.id("inquiries"), round: v.number() },
  returns: v.boolean(),
  handler: async (ctx, { inquiryId, round }) => {
    const messages = await ctx.db
      .query("threadMessages")
      .withIndex("by_inquiry", (q) => q.eq("inquiryId", inquiryId))
      .collect();
    return messages.some((m) => m.direction === "outbound" && m.round === round);
  },
});

/**
 * The safety net behind the agent.
 *
 * The agent decides whether to write back, and it is the right thing to be
 * making that call. But this runs on camera, and a model can fail in two ways
 * that both end with a family staring at a row that never resolves:
 *
 *  1. it never reads the reply at all, so nothing is extracted and the row sits
 *     at "replied" forever;
 *  2. it reads the reply, sees a dodged question, and answers in prose instead
 *     of writing back.
 *
 * Both have actually happened here, so this covers both. It checks the outcome
 * rather than the intention: is the reply read, and if the family is still owed
 * an answer, did a letter go out? Whatever is missing, it does.
 *
 * It shares `parseReply` and `sendFollowUp` with the agent, and `sendFollowUp`
 * refuses a second letter for a round that already has one, so the two cannot
 * collide even if the agent is still running when this fires.
 */
export const ensureReplyHandled = internalAction({
  args: { inquiryId: v.id("inquiries"), round: v.number() },
  returns: v.object({
    parsed: v.boolean(),
    sent: v.boolean(),
    reason: v.string(),
  }),
  handler: async (
    ctx,
    { inquiryId, round },
  ): Promise<{ parsed: boolean; sent: boolean; reason: string }> => {
    const loaded = await ctx.runQuery(internal.email.inquiryForSend, { inquiryId });
    if (!loaded?.inquiry) {
      return { parsed: false, sent: false, reason: "no_such_inquiry" };
    }
    let inquiry = loaded.inquiry as Doc<"inquiries">;

    // Failure 1: the reply was never read. `replied` is the status ingest sets
    // and `applyParse` always moves off, so a row still sitting there means no
    // parse ever landed.
    let parsedHere = false;
    if (inquiry.status === "replied") {
      console.warn(
        `[email] the agent did not read ${inquiry.facilityName}'s reply; ` +
          `the reconciliation sweep is reading it`,
      );
      await ctx.runAction(internal.email.parseReply, { inquiryId, round });
      parsedHere = true;
      const reloaded = await ctx.runQuery(internal.email.inquiryForSend, {
        inquiryId,
      });
      if (!reloaded?.inquiry) {
        return { parsed: true, sent: false, reason: "no_such_inquiry" };
      }
      inquiry = reloaded.inquiry as Doc<"inquiries">;
    }

    // Failure 2: something is still owed and no letter went out for it.
    const vague =
      inquiry.confidence !== undefined && inquiry.confidence < LOW_CONFIDENCE;
    if (inquiry.unanswered.length === 0 && !vague) {
      return { parsed: parsedHere, sent: false, reason: "nothing_left_to_ask" };
    }
    const nextRound = round + 1;
    if (nextRound > MAX_ROUNDS) {
      return { parsed: parsedHere, sent: false, reason: "round_cap_reached" };
    }

    const result: { sent: boolean; reason: string } = await ctx.runAction(
      internal.email.sendFollowUp,
      {
        inquiryId,
        round: nextRound,
        reason: inquiry.unanswered.length > 0 ? "unanswered" : "low_confidence",
      },
    );
    if (result.sent) {
      console.warn(
        `[email] the agent did not send round ${nextRound} for ` +
          `${inquiry.facilityName}; the reconciliation sweep sent it`,
      );
    }
    return { parsed: parsedHere, sent: result.sent, reason: result.reason };
  },
});

// =============================================================================
// The nudge — one, after 72 hours of silence, and never more
// =============================================================================

/**
 * The two halves of silence.
 *
 * A facility that has not answered in three days is almost never ignoring a
 * family — they are short-staffed and the email is below a pile of them. So one
 * short note goes out, on its own, and that is the end of it. If the nudge is
 * also met with silence the row settles at `no_response`, which is an honest
 * answer a family can act on: this place did not get back to you, here is their
 * phone number.
 *
 * A second chase email is harassment, not persistence. `nudgeCount` is the
 * whole guarantee and it is checked in the mutation that increments it, so
 * there is no interleaving of two sweeps that can produce a second one.
 */

export const silentInquiries = internalQuery({
  args: { olderThanMs: v.number() },
  returns: v.array(v.id("inquiries")),
  handler: async (ctx, { olderThanMs }) => {
    const cutoff = Date.now() - olderThanMs;
    // Indexed on (status, sentAt) and bounded: a sweep that runs every hour
    // across every family in the system must never read a conversation that
    // has already been answered.
    const out = [];
    for (const status of ["sent", "delivered"] as const) {
      const stale = await ctx.db
        .query("inquiries")
        .withIndex("by_status_sent", (q) =>
          q.eq("status", status).gt("sentAt", 0).lt("sentAt", cutoff),
        )
        .take(200);
      for (const i of stale) if (i.nudgeCount === 0) out.push(i._id);
    }
    return out;
  },
});

/** Nudged once, still nothing. These are the rows that settle. */
export const stillSilentAfterNudge = internalQuery({
  args: { olderThanMs: v.number() },
  returns: v.array(v.id("inquiries")),
  handler: async (ctx, { olderThanMs }) => {
    const cutoff = Date.now() - olderThanMs;
    const out = [];
    for (const status of ["sent", "delivered"] as const) {
      const stale = await ctx.db
        .query("inquiries")
        .withIndex("by_status_nudged", (q) =>
          q.eq("status", status).gt("lastNudgeAt", 0).lt("lastNudgeAt", cutoff),
        )
        .take(200);
      for (const i of stale) {
        if (i.nudgeCount >= 1 && i.lastInboundAt === undefined) out.push(i._id);
      }
    }
    return out;
  },
});

/**
 * Claim the one nudge this inquiry will ever get.
 *
 * Returns false if it has already been claimed. The check and the increment are
 * in the same mutation, so two sweeps running at once cannot both win.
 */
export const claimNudge = internalMutation({
  args: { inquiryId: v.id("inquiries") },
  returns: v.boolean(),
  handler: async (ctx, { inquiryId }) => {
    const inquiry = await ctx.db.get(inquiryId);
    if (!inquiry || inquiry.nudgeCount > 0) return false;
    await ctx.db.patch(inquiryId, { nudgeCount: 1, lastNudgeAt: Date.now() });
    return true;
  },
});

export const markNoResponse = internalMutation({
  args: { inquiryId: v.id("inquiries") },
  returns: v.null(),
  handler: async (ctx, { inquiryId }) => {
    const inquiry = await ctx.db.get(inquiryId);
    // A reply that landed between the sweep's read and this write wins.
    if (!inquiry || inquiry.lastInboundAt !== undefined) return null;
    await ctx.db.patch(inquiryId, { status: "no_response" });
    return null;
  },
});

/**
 * The nudge itself.
 *
 * No model is called. A nudge says the same thing to every facility in every
 * campaign — it is four sentences and it does not need to be written twice, let
 * alone written by a large model twelve times a week (CLAUDE.md section 10).
 * It goes into the same thread, so a coordinator sees their own inbox thread
 * float back up rather than a second cold email.
 */
export const sendNudge = internalAction({
  args: { inquiryId: v.id("inquiries") },
  returns: v.object({ sent: v.boolean(), reason: v.string() }),
  handler: async (
    ctx,
    { inquiryId },
  ): Promise<{ sent: boolean; reason: string }> => {
    const claimed: boolean = await ctx.runMutation(internal.email.claimNudge, {
      inquiryId,
    });
    if (!claimed) return { sent: false, reason: "already_nudged" };

    const loaded = await ctx.runQuery(internal.email.inquiryForSend, { inquiryId });
    if (!loaded?.inquiry || !loaded.search) {
      return { sent: false, reason: "no_such_inquiry" };
    }
    const { inquiry, search } = loaded as {
      inquiry: Doc<"inquiries">;
      search: Doc<"searches">;
    };

    const previous = await ctx.runQuery(internal.email.lastOutboundFor, { inquiryId });
    const body = [
      "Hello,",
      "",
      "I wrote a few days ago about a place for my mother and I know how busy " +
        "admissions gets, so this is just a short note in case my email got " +
        "buried.",
      "",
      "If it is easier to answer just the first two — whether you have an " +
        "opening and roughly what it costs a month — that would help us a lot.",
      "",
      `Thank you,\nThe ${search.label} family`,
    ].join("\n");
    const subject = `Re: ${(previous?.subject ?? inquiry.facilityName).replace(
      /^(\s*re\s*:\s*)+/i,
      "",
    )}`;

    let outboundId: string | undefined;
    try {
      const anchor = threadAnchor(undefined, inquiry.outboundMessageId);
      if ((demoRealDelivery() || !inquiry.simulated) && anchor) {
        const id = await agentmail.replyToMessage(
          amCtx(ctx),
          search.inboxId,
          anchor,
          { text: body, labels: [`search:${search._id}`, `ccn:${inquiry.ccn}`] },
        );
        outboundId = id as unknown as string;
      }
    } catch (error) {
      console.error(`[email] nudge send failed for ${inquiryId}: ${error}`);
    }

    // The nudge is not a round. Rounds are the questions-and-answers a family
    // watches; a nudge added nothing to the conversation and must not inflate
    // the counter on the board.
    await ctx.runMutation(internal.email.recordNudgeMessage, {
      inquiryId,
      outboundId,
      subject,
      body,
      fromAddress: search.inboxEmail,
      toAddress: inquiry.toEmail,
    });
    return { sent: true, reason: "nudged" };
  },
});

export const lastOutboundFor = internalQuery({
  args: { inquiryId: v.id("inquiries") },
  returns: v.union(v.null(), v.any()),
  handler: async (ctx, { inquiryId }) => {
    const messages = await ctx.db
      .query("threadMessages")
      .withIndex("by_inquiry", (q) => q.eq("inquiryId", inquiryId))
      .collect();
    const outbound = messages.filter((m) => m.direction === "outbound");
    return outbound[outbound.length - 1] ?? null;
  },
});

export const recordNudgeMessage = internalMutation({
  args: {
    inquiryId: v.id("inquiries"),
    outboundId: v.optional(v.string()),
    subject: v.string(),
    body: v.string(),
    fromAddress: v.string(),
    toAddress: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const inquiry = await ctx.db.get(args.inquiryId);
    if (!inquiry) return null;
    await ctx.db.insert("threadMessages", {
      inquiryId: args.inquiryId,
      searchId: inquiry.searchId,
      direction: "outbound",
      round: inquiry.rounds, // the same round; a nudge repeats, it does not ask
      subject: args.subject,
      body: args.body,
      fromAddress: args.fromAddress,
      toAddress: args.toAddress,
      threadId: inquiry.threadId,
      simulated: false,
      model: "no-model-nudge",
      createdAt: Date.now(),
    });
    if (args.outboundId) {
      await ctx.db.patch(args.inquiryId, { outboundId: args.outboundId });
    }
    return null;
  },
});

/**
 * Cron: one polite nudge, 72 hours after a letter went unanswered.
 */
export const nudgeSweep = internalAction({
  args: {},
  returns: v.object({ nudged: v.number() }),
  handler: async (ctx): Promise<{ nudged: number }> => {
    const ids: Id<"inquiries">[] = await ctx.runQuery(
      internal.email.silentInquiries,
      { olderThanMs: nudgeAfterMs() },
    );
    let nudged = 0;
    for (const inquiryId of ids) {
      const result: { sent: boolean } = await ctx.runAction(
        internal.email.sendNudge,
        { inquiryId },
      );
      if (result.sent) nudged += 1;
    }
    return { nudged };
  },
});

/**
 * Cron: settle the rows that were nudged and stayed silent.
 *
 * Runs on the same clock as the nudge, so a facility gets the same three days
 * to answer the nudge that it got to answer the letter.
 */
export const noResponseSweep = internalAction({
  args: {},
  returns: v.object({ settled: v.number() }),
  handler: async (ctx): Promise<{ settled: number }> => {
    const ids: Id<"inquiries">[] = await ctx.runQuery(
      internal.email.stillSilentAfterNudge,
      { olderThanMs: nudgeAfterMs() },
    );
    for (const inquiryId of ids) {
      await ctx.runMutation(internal.email.markNoResponse, { inquiryId });
    }
    return { settled: ids.length };
  },
});

// =============================================================================
// Stale answers — what a facility told us has a shelf life
// =============================================================================

/**
 * Cron: mark availability answers older than thirty days as stale.
 *
 * The federal half of a row ages gracefully: an inspection from March is still
 * an inspection from March, and it says so. The email half does not. "One room
 * open now" was true on the day it was written and is worth nothing four months
 * later, and a family who reads it as current will drive an hour for a room
 * that went in April.
 *
 * So this is a cron rather than a computed field on read: flipping a stored
 * flag is what makes the badge appear on a board somebody already has open,
 * without them refreshing anything.
 */
export const staleSweep = internalMutation({
  args: {},
  returns: v.object({ marked: v.number() }),
  handler: async (ctx) => {
    const cutoff = Date.now() - staleAfterMs();
    // Bounded, and it does not need to be exhaustive: this runs daily, and a
    // row that misses today's batch is marked tomorrow.
    const answered = await ctx.db
      .query("inquiries")
      .withIndex("by_status_answered", (q) =>
        q.eq("status", "answered").lt("answeredAt", cutoff),
      )
      .take(500);

    let marked = 0;
    for (const inquiry of answered) {
      if (inquiry.staleAt !== undefined) continue;
      await ctx.db.patch(inquiry._id, { staleAt: Date.now() });
      marked += 1;
    }
    return { marked };
  },
});

// =============================================================================
// Reactive reads
// =============================================================================

/** The conversation, both directions, in order. Subscribed to by the UI. */
export const thread = query({
  args: { inquiryId: v.id("inquiries") },
  returns: v.union(
    v.null(),
    v.object({
      facilityName: v.string(),
      status: v.string(),
      rounds: v.number(),
      simulated: v.boolean(),
      persona: v.union(v.string(), v.null()),
      toEmail: v.string(),
      intendedTo: v.union(v.string(), v.null()),
      inboxEmail: v.string(),
      deliveryStatus: v.union(v.string(), v.null()),
      unanswered: v.array(v.string()),
      unansweredLabels: v.array(v.string()),
      confidence: v.union(v.number(), v.null()),
      followUpReason: v.union(v.string(), v.null()),
      maxRounds: v.number(),
      nudgeCount: v.number(),
      staleAt: v.union(v.number(), v.null()),
      messages: v.array(
        v.object({
          id: v.id("threadMessages"),
          direction: v.string(),
          round: v.number(),
          subject: v.string(),
          body: v.string(),
          fromAddress: v.string(),
          toAddress: v.string(),
          simulated: v.boolean(),
          model: v.union(v.string(), v.null()),
          persona: v.union(v.string(), v.null()),
          createdAt: v.number(),
        }),
      ),
    }),
  ),
  handler: async (ctx, { inquiryId }) => {
    const inquiry = await ctx.db.get(inquiryId);
    if (!inquiry) return null;
    // A thread carries a family's own words. Only they may read it.
    const userId = await getAuthUserId(ctx);
    const search = await ctx.db.get(inquiry.searchId);
    if (!userId || !search || search.userId !== userId) return null;
    const messages = await ctx.db
      .query("threadMessages")
      .withIndex("by_inquiry", (q) => q.eq("inquiryId", inquiryId))
      .collect();

    return {
      facilityName: inquiry.facilityName,
      status: inquiry.status,
      rounds: inquiry.rounds,
      simulated: inquiry.simulated,
      persona: inquiry.persona ?? null,
      toEmail: inquiry.toEmail,
      intendedTo: inquiry.intendedTo ?? null,
      inboxEmail: search?.inboxEmail ?? "",
      deliveryStatus: inquiry.deliveryStatus ?? null,
      unanswered: inquiry.unanswered,
      unansweredLabels: inquiry.unanswered.map(
        (k) => QUESTION_LABEL[k as QuestionKey] ?? k,
      ),
      confidence: inquiry.confidence ?? null,
      followUpReason: inquiry.followUpReason ?? null,
      maxRounds: MAX_ROUNDS,
      nudgeCount: inquiry.nudgeCount,
      staleAt: inquiry.staleAt ?? null,
      messages: messages
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((m) => ({
          id: m._id,
          direction: m.direction,
          round: m.round,
          subject: m.subject,
          body: m.body,
          fromAddress: m.fromAddress,
          toAddress: m.toAddress,
          simulated: m.simulated,
          model: m.model ?? null,
          persona: m.persona ?? null,
          createdAt: m.createdAt,
        })),
    };
  },
});

/**
 * Whether this deployment could email a real facility right now.
 *
 * Read by the UI so the guard's state is visible on screen rather than only in
 * an environment variable nobody can see.
 */
export const sendingPosture = query({
  args: {},
  returns: v.object({
    demoMode: v.boolean(),
    liveSendingPermitted: v.boolean(),
    realDelivery: v.boolean(),
  }),
  handler: async () => ({
    demoMode: demoModeEnabled(),
    liveSendingPermitted: liveSendingPermitted(),
    realDelivery: demoRealDelivery(),
  }),
});

export {
  agentmail,
  amCtx,
  inquiryPool,
  LOW_CONFIDENCE,
  MAX_ROUNDS,
  SEND_STAGGER_MS,
  resolveRecipient,
};
