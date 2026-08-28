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

/** Sends are staggered so the board fills in rather than blinking on at once. */
const SEND_STAGGER_MS = 1_200;

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
    if (search.letterDraft && !force) {
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
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const inquiry = await ctx.db.get(args.inquiryId);
    if (!inquiry) return null;

    await ctx.db.patch(args.inquiryId, {
      status: args.status,
      outboundId: args.outboundId,
      sentAt: inquiry.sentAt ?? Date.now(),
      rounds: args.round,
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
    });

    // Reading the reply needs a model, so it cannot happen inside a mutation.
    await ctx.scheduler.runAfter(0, internal.email.parseReply, {
      inquiryId: args.inquiryId,
      body: args.body,
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

    const unanswered = args.unanswered;
    const complete = unanswered.length === 0;
    const exhausted = args.round >= MAX_ROUNDS;

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
      status: complete || exhausted ? "answered" : "clarifying",
      answeredAt: complete || exhausted ? Date.now() : undefined,
    });

    // The moment the product is about: they left something out, so the agent
    // writes back in the same thread and asks again. Once.
    if (!complete && !exhausted) {
      await ctx.scheduler.runAfter(3_000, internal.email.sendFollowUp, {
        inquiryId: args.inquiryId,
        round: args.round + 1,
      });
    }
    return null;
  },
});

export const parseReply = internalAction({
  args: { inquiryId: v.id("inquiries"), body: v.string(), round: v.number() },
  returns: v.null(),
  handler: async (ctx, { inquiryId, body, round }) => {
    const loaded = await ctx.runQuery(internal.email.inquiryForSend, { inquiryId });
    if (!loaded?.inquiry || !loaded.search) return null;
    const { inquiry, search } = loaded as {
      inquiry: Doc<"inquiries">;
      search: Doc<"searches">;
    };

    // A bounce notice is not something to spend a model call reading.
    if (!body.trim()) return null;

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
      });
      parsed = result.object;
    } catch (error) {
      console.error(`[email] reply parse failed for ${inquiryId}: ${error}`);
      return null;
    }

    const nn = <T,>(value: T | null): T | undefined =>
      value === null ? undefined : value;

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
      unanswered: deriveUnanswered(parsed),
      confidence: parsed.confidence,
      replySummary: parsed.replySummary,
      isAutoReply: parsed.isAutoReply,
    });
    return null;
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
  args: { inquiryId: v.id("inquiries"), round: v.number() },
  returns: v.null(),
  handler: async (ctx, { inquiryId, round }) => {
    const loaded = await ctx.runQuery(internal.email.inquiryForSend, { inquiryId });
    if (!loaded?.inquiry || !loaded.search) return null;
    const { inquiry, search } = loaded as {
      inquiry: Doc<"inquiries">;
      search: Doc<"searches">;
    };
    if (inquiry.unanswered.length === 0) return null;
    if (round > MAX_ROUNDS) return null;

    const previous = await ctx.runQuery(internal.email.lastInboundFor, { inquiryId });
    const missing = inquiry.unanswered as QuestionKey[];
    const tourDates = tourWindow(Date.now());

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

    const prompt = [
      `${inquiry.facilityName} replied to the family's email.`,
      `What they DID answer: ${answered || "very little"}.`,
      `What they left out: ${missing.map((k) => QUESTION_LABEL[k]).join(", ")}.`,
      `Care level: ${careLevelPhrase(search.careLevel)}. Tour dates on offer: ${tourDates}.`,
      "",
      "Their reply, verbatim, so the thank-you can name something real:",
      "---",
      String(previous?.body ?? "").slice(0, 4_000),
      "---",
    ].join("\n");

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
      if ((demoRealDelivery() || !inquiry.simulated) && inquiry.outboundMessageId) {
        // Same thread, so the facility sees one conversation rather than a
        // second cold email.
        const id = await agentmail.replyToMessage(
          amCtx(ctx),
          search.inboxId,
          previous?.messageId ?? inquiry.outboundMessageId,
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
    });

    if (inquiry.simulated) {
      await ctx.runMutation(internal.demo.schedulePersonaReply, { inquiryId, round });
    }
    return null;
  },
});

// =============================================================================
// The nudge — one, after 72 hours of silence, and never more
// =============================================================================

export const silentInquiries = internalQuery({
  args: { olderThanMs: v.number() },
  returns: v.array(v.id("inquiries")),
  handler: async (ctx, { olderThanMs }) => {
    const cutoff = Date.now() - olderThanMs;
    const all = await ctx.db.query("inquiries").collect();
    return all
      .filter(
        (i) =>
          (i.status === "sent" || i.status === "delivered") &&
          i.nudgeCount === 0 &&
          (i.sentAt ?? 0) > 0 &&
          (i.sentAt ?? 0) < cutoff,
      )
      .map((i) => i._id);
  },
});

export const recordNudge = internalMutation({
  args: { inquiryId: v.id("inquiries") },
  returns: v.null(),
  handler: async (ctx, { inquiryId }) => {
    const inquiry = await ctx.db.get(inquiryId);
    if (!inquiry || inquiry.nudgeCount > 0) return null;
    await ctx.db.patch(inquiryId, {
      nudgeCount: 1,
      lastNudgeAt: Date.now(),
      status: "no_response",
    });
    return null;
  },
});

/**
 * One polite nudge, 72 hours after a letter went unanswered.
 *
 * One. These are understaffed places and a second chase email is harassment,
 * not persistence (CLAUDE.md section 4).
 */
export const nudgeSweep = internalAction({
  args: {},
  returns: v.object({ nudged: v.number() }),
  handler: async (ctx): Promise<{ nudged: number }> => {
    const ids: Id<"inquiries">[] = await ctx.runQuery(
      internal.email.silentInquiries,
      { olderThanMs: 72 * 60 * 60 * 1000 },
    );
    for (const inquiryId of ids) {
      await ctx.runMutation(internal.email.recordNudge, { inquiryId });
    }
    return { nudged: ids.length };
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

export { agentmail, amCtx, inquiryPool, MAX_ROUNDS, SEND_STAGGER_MS, resolveRecipient };
