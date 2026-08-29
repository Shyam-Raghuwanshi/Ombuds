import { v } from "convex/values";
import { z } from "zod";
import { Agent, createTool, type ToolCtx } from "@convex-dev/agent";
import { getAuthUserId } from "@convex-dev/auth/server";
import { stepCountIs } from "ai";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { api, components, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { normalizeUsage, resolveModel } from "./ai/provider";
import { careLevelPhrase } from "./lib/questions";
// One definition of what reading a reply produces, shared with the action that
// produces it, so the tool contract and the parser cannot drift apart.
import type { ParseOutcome } from "./email";

/**
 * The agent loop.
 *
 * Everything up to this file is a pipeline: a letter goes out, a reply comes
 * back, fields are extracted. A pipeline cannot do the one thing this product
 * exists to do, which is notice that a facility answered four questions out of
 * five and go back and ask for the fifth. That is a judgement, and this is
 * where it is made.
 *
 * The loop runs inside Convex through the Agent component, with five tools:
 *
 *   lookupFacility  what the federal record says about this home, including the
 *                   published staffing hours — which is how a facility's own
 *                   claim about night staffing gets checked against CMS
 *   parseReply      read the reply that just arrived into structured fields
 *   sendFollowUp    write back in the same thread, asking for what is missing
 *   sendInquiry     open a conversation with a facility not yet on the list
 *   rankResults     order the board against what this family actually needs
 *
 * Two design decisions worth stating plainly:
 *
 *  1. **The model decides; the code enforces.** Whether to write back a second
 *     time is the agent's call. Whether a second letter is ALLOWED is not: the
 *     round cap, the idempotency guard, and the send guard all live in
 *     `convex/email.ts` and refuse the agent exactly as they refuse anything
 *     else. A model that decided to send eight follow-ups would send one.
 *
 *  2. **The agent is load-bearing but not load-critical.** After the agent
 *     finishes, a reconciliation checks the outcome rather than the intention:
 *     if a question is still unanswered and no letter went out, one is sent.
 *     This runs on camera, and a model returning prose instead of a tool call
 *     must not be able to cost a family their follow-up.
 *
 * Every call the loop makes is metered — the component's usage handler writes
 * each one into `modelUsage`, which is what the cost figure under the board is
 * summed from. We pay for this ourselves (CLAUDE.md section 10).
 */

const loopModel = resolveModel("agentLoop");

const INSTRUCTIONS = `You are the agent inside Ombuds, which helps a family find a safe care facility for their parent. You handle one email conversation with one facility.

The family asked five things that facilities never publish: whether there is an opening, the all-in monthly cost, the waitlist length, the overnight caregiver-to-resident ratio, and whether they can tour.

Your job when a reply arrives:
1. Call parseReply to read it.
2. Look at what came back. If any of the five is unanswered, or the confidence is below 0.6, call sendFollowUp. That is the whole point of your existence: "pricing depends on her care level" is the most common answer in this industry and it is not an answer.
3. If the reply mentions the facility's own staffing, call lookupFacility first. The federal record publishes what this building actually reports, and the follow-up should ask for a number that can be compared to it.
4. If the reply names another specific facility with availability, call lookupFacility for it, and call sendInquiry if it exists in the federal record.
5. Finish with one short sentence saying what you did and why. No preamble.

Rules:
- One follow-up per facility, ever. If sendFollowUp tells you the round cap is reached, accept it and stop. These are understaffed places caring for real people and a second chase email is harassment.
- Never call sendFollowUp when nothing is unanswered and confidence is fine. A facility that answered properly is left alone.
- Never invent a fact about a facility. Everything you know comes from the tools.
- Never give medical, legal, or financial advice.`;

// =============================================================================
// Tools
// =============================================================================

/**
 * Every tool's `execute` is annotated with its return type.
 *
 * Not stylistic: a tool defined here calls a Convex function whose api types are
 * generated from this same file, and without an explicit annotation TypeScript
 * walks into that cycle and gives up with "implicitly has type any". These
 * aliases are the cut in the cycle, and they double as the contract the model
 * actually sees.
 */
type FacilityFacts =
  | { found: false; searchedFor: string }
  | {
      found: true;
      ccn: string;
      name: string;
      city: string;
      state: string;
      phone: string;
      ownershipType: string;
      certifiedBeds: number;
      overallRating: number | null;
      staffingRating: number | null;
      abuseFlag: boolean;
      specialFocusStatus: string | null;
      actualHarmCitations: number;
      immediateJeopardyCitations: number;
      latestSurveyDate: number | null;
      rnHoursWeekend: number | null;
      totalNurseHours: number | null;
      nurseTurnoverPercent: number | null;
      numberOfFines: number | null;
      totalFinesUsd: number | null;
      changedOwnershipLast12Months: boolean | null;
      contactEmail: string | null;
      source: string;
    };

type SendOutcome = { sent: boolean; reason: string };

type QueueOutcome = {
  queued: boolean;
  reason: string;
  facilityName?: string;
  inquiryId?: Id<"inquiries">;
};

type InquiryState = {
  rounds: number;
  status: string;
  searchId: Id<"searches">;
  facilityName: string;
  ccn: string;
  unanswered: string[];
  confidence: number | null;
  agentThreadId: string | null;
};

/**
 * What the federal record says.
 *
 * The staffing numbers are the reason this tool exists rather than being a
 * convenience. CMS publishes registered nurse hours per resident per day at the
 * weekend for every certified building in the country, and a facility that
 * emails a family "we always exceed state minimums" can be asked, specifically,
 * for the number that sits next to it (CLAUDE.md section 6).
 */
const lookupFacility = createTool({
  description:
    "Look up what the federal CMS record says about a care facility: its " +
    "star ratings, its harm-level citations, its published staffing hours, " +
    "fines, and whether CMS has flagged it as a chronic poor performer. Search " +
    "by CCN or by name. Returns nothing invented — only the federal record.",
  inputSchema: z.object({
    ccn: z
      .string()
      .nullable()
      .describe("The CMS certification number, if you know it."),
    name: z
      .string()
      .nullable()
      .describe("Part of the facility's name, if you do not know the CCN."),
  }),
  execute: async (ctx: ToolCtx, { ccn, name }): Promise<FacilityFacts> => {
    return await ctx.runQuery(internal.agentLoop.facilityFacts, {
      ccn: ccn ?? undefined,
      name: name ?? undefined,
    });
  },
});

/**
 * The three tools that act on a specific conversation are built per turn, with
 * the ids closed over rather than passed in.
 *
 * This started as a robustness fix and is really a correctness one. Asked to
 * carry `kh72n8cy850c78vv9w74wgfw498dbs7p` from a prompt into a tool call, the
 * model transposes a character often enough to matter, and the failure is
 * silent in the worst way: the tool call succeeds in the model's view, the
 * argument validator rejects an id that does not exist, and a family's
 * follow-up quietly never goes out.
 *
 * A model cannot mistype an argument it was never asked for. What is left for
 * it to decide is the only thing it should have been deciding: whether to write
 * back at all, and why.
 */
function conversationTools(inquiryId: Id<"inquiries">, searchId: Id<"searches">) {
  return {
    parseReply: createTool({
      description:
        "Read the most recent reply from this facility and extract what it " +
        "actually says into structured fields. Returns which of the five " +
        "questions were left unanswered and how confident the extraction is. " +
        "Call this first when a reply arrives.",
      // `round` rather than no arguments at all. A tool declared with an empty
      // parameter object is one this model will not call — it burns its steps
      // and answers in prose instead, which is how a whole rehearsal run ended
      // up with four replies received and none of them read. A small integer
      // the prompt already states is something it cannot get wrong.
      inputSchema: z.object({
        round: z
          .number()
          .int()
          .describe("Which round of this conversation you are reading. The prompt says."),
      }),
      execute: async (ctx: ToolCtx, { round }): Promise<ParseOutcome> => {
        return await ctx.runAction(internal.email.parseReply, {
          inquiryId,
          round,
        });
      },
    }),

    sendFollowUp: createTool({
      description:
        "Write back to this facility in the same email thread, asking again " +
        "for what they left out or hedged. Use when parseReply reports " +
        "unanswered questions or confidence below 0.6. Capped at one " +
        "follow-up per facility: if it refuses, accept it and stop.",
      inputSchema: z.object({
        reason: z
          .enum(["unanswered", "low_confidence"])
          .describe(
            "unanswered: they skipped one or more of the five. " +
              "low_confidence: they addressed everything but too vaguely to " +
              "plan around.",
          ),
      }),
      execute: async (ctx: ToolCtx, { reason }): Promise<SendOutcome> => {
        const current: InquiryState | null = await ctx.runQuery(
          internal.agentLoop.inquiryRounds,
          { inquiryId },
        );
        if (!current) return { sent: false, reason: "no_such_inquiry" };
        // The round number is derived here, not asked of the model. A model
        // that could choose its own round number could choose one that has not
        // been sent yet and walk straight past the cap.
        return await ctx.runAction(internal.email.sendFollowUp, {
          inquiryId,
          round: current.rounds + 1,
          reason,
        });
      },
    }),

    sendInquiry: createTool({
      description:
        "Add a facility to this family's campaign and send it the family's " +
        "opening letter. Use when a reply points at another specific facility " +
        "that may have availability. Look the facility up first — this only " +
        "works for facilities that exist in the federal record.",
      inputSchema: z.object({
        ccn: z
          .string()
          .describe("The CMS certification number, from lookupFacility."),
      }),
      execute: async (ctx: ToolCtx, { ccn }): Promise<QueueOutcome> => {
        return await ctx.runAction(internal.email.sendInquiryToFacility, {
          searchId,
          ccn,
        });
      },
    }),
  };
}

/** The ranking tool, likewise bound to one search. */
function rankingTools(searchId: Id<"searches">) {
  return {
    rankResults: createTool({
      description:
        "Order this family's shortlist against what they actually said they " +
        "need — their care level, their budget, and their must-haves — using " +
        "both the federal inspection record and what each facility said by " +
        "email. Returns the current state of every row so you can rank it.",
      inputSchema: z.object({
        includeUnreplied: z
          .boolean()
          .describe(
            "Whether to include facilities that have not answered yet. They " +
              "cannot be ranked on availability, only on their inspection " +
              "record, so include them only if the family should still see them.",
          ),
      }),
      execute: async (ctx: ToolCtx, { includeUnreplied }): Promise<unknown> => {
        return await ctx.runQuery(internal.agentLoop.rankingInputs, {
          searchId,
          includeUnreplied,
        });
      },
    }),
  };
}

export const ombuds = new Agent(components.agent, {
  name: "ombuds",
  languageModel: loopModel.model,
  instructions: INSTRUCTIONS,
  // Only the tool that needs no conversation bound to it lives here. The rest
  // are supplied per turn by `conversationTools` / `rankingTools`, which is
  // also what keeps a reply turn from being handed a ranking tool it has no
  // business calling.
  tools: { lookupFacility },
  // Read the reply, maybe look the facility up, maybe write back, then say what
  // you did. Six steps is comfortably more than that and still a hard stop.
  stopWhen: stepCountIs(6),
  /**
   * Every model call the component makes lands in our own ledger, attributed
   * back to the family's search through `agentThreads`. This is how the cost
   * figure under the board can claim to be the whole cost of the search rather
   * than the part that happened to be convenient to count.
   */
  usageHandler: async (ctx, { threadId, usage, model, provider }) => {
    await ctx.runMutation(internal.usage.recordForThread, {
      threadId,
      purpose: "agentLoop",
      provider,
      model,
      ...normalizeUsage(usage),
    });
  },
});

// =============================================================================
// What the tools read
// =============================================================================

export const facilityFacts = internalQuery({
  args: { ccn: v.optional(v.string()), name: v.optional(v.string()) },
  returns: v.union(
    v.object({ found: v.literal(false), searchedFor: v.string() }),
    v.object({
      found: v.literal(true),
      ccn: v.string(),
      name: v.string(),
      city: v.string(),
      state: v.string(),
      phone: v.string(),
      ownershipType: v.string(),
      certifiedBeds: v.number(),
      overallRating: v.union(v.number(), v.null()),
      staffingRating: v.union(v.number(), v.null()),
      abuseFlag: v.boolean(),
      specialFocusStatus: v.union(v.string(), v.null()),
      actualHarmCitations: v.number(),
      immediateJeopardyCitations: v.number(),
      latestSurveyDate: v.union(v.number(), v.null()),
      // The half of the record that a facility's own staffing claim gets
      // checked against. Null means CMS published no figure — which is a fact
      // about the record, never a zero.
      rnHoursWeekend: v.union(v.number(), v.null()),
      totalNurseHours: v.union(v.number(), v.null()),
      nurseTurnoverPercent: v.union(v.number(), v.null()),
      numberOfFines: v.union(v.number(), v.null()),
      totalFinesUsd: v.union(v.number(), v.null()),
      changedOwnershipLast12Months: v.union(v.boolean(), v.null()),
      contactEmail: v.union(v.string(), v.null()),
      source: v.string(),
    }),
  ),
  handler: async (ctx, { ccn, name }) => {
    let facility: Doc<"facilities"> | null = null;

    if (ccn) {
      facility = await ctx.db
        .query("facilities")
        .withIndex("by_ccn", (q) => q.eq("ccn", ccn))
        .unique();
    }
    if (!facility && name) {
      // A name match is a fallback, not the key. Facility names repeat across
      // the country and chains share a brand, so this only ever looks inside
      // what we have already ingested and never guesses.
      const needle = name.toLowerCase().trim();
      const candidates = await ctx.db.query("facilities").take(500);
      facility =
        candidates.find((f) => f.name.toLowerCase().includes(needle)) ??
        candidates.find((f) =>
          needle.includes(f.name.toLowerCase().slice(0, 14)),
        ) ??
        null;
    }
    if (!facility) {
      return { found: false as const, searchedFor: ccn ?? name ?? "" };
    }

    const harm = await ctx.db
      .query("deficiencies")
      .withIndex("by_ccn_harm", (q) =>
        q.eq("ccn", facility!.ccn).eq("harmLevel", "actual_harm"),
      )
      .collect();
    const jeopardy = await ctx.db
      .query("deficiencies")
      .withIndex("by_ccn_harm", (q) =>
        q.eq("ccn", facility!.ccn).eq("harmLevel", "immediate_jeopardy"),
      )
      .collect();
    const latest = Math.max(
      0,
      ...harm.map((d) => d.surveyDate),
      ...jeopardy.map((d) => d.surveyDate),
    );

    return {
      found: true as const,
      ccn: facility.ccn,
      name: facility.name,
      city: facility.city,
      state: facility.state,
      phone: facility.phone,
      ownershipType: facility.ownershipType,
      certifiedBeds: facility.certifiedBeds,
      // Zero is CMS's way of saying "unrated", which happens for Special Focus
      // Facilities among others. Null so the agent cannot read it as one star.
      overallRating: facility.overallRating || null,
      staffingRating: facility.staffingRating || null,
      abuseFlag: facility.abuseIcon,
      specialFocusStatus: facility.specialFocusStatus ?? null,
      actualHarmCitations: harm.length,
      immediateJeopardyCitations: jeopardy.length,
      latestSurveyDate: latest || null,
      rnHoursWeekend: facility.rnHoursWeekend ?? null,
      totalNurseHours: facility.totalNurseHours ?? null,
      nurseTurnoverPercent: facility.nurseTurnover ?? null,
      numberOfFines: facility.numberOfFines ?? null,
      totalFinesUsd: facility.totalFinesUsd ?? null,
      changedOwnershipLast12Months:
        facility.changedOwnershipLast12Months ?? null,
      contactEmail: facility.contactEmail ?? null,
      source: "CMS Provider Data Catalog, dataset 4pq5-n9py",
    };
  },
});

export const inquiryRounds = internalQuery({
  args: { inquiryId: v.id("inquiries") },
  returns: v.union(
    v.null(),
    v.object({
      rounds: v.number(),
      status: v.string(),
      searchId: v.id("searches"),
      facilityName: v.string(),
      ccn: v.string(),
      unanswered: v.array(v.string()),
      confidence: v.union(v.number(), v.null()),
      agentThreadId: v.union(v.string(), v.null()),
    }),
  ),
  handler: async (ctx, { inquiryId }) => {
    const inquiry = await ctx.db.get(inquiryId);
    if (!inquiry) return null;
    return {
      rounds: inquiry.rounds,
      status: inquiry.status,
      searchId: inquiry.searchId,
      facilityName: inquiry.facilityName,
      ccn: inquiry.ccn,
      unanswered: inquiry.unanswered,
      confidence: inquiry.confidence ?? null,
      agentThreadId: inquiry.agentThreadId ?? null,
    };
  },
});

export const rankingInputs = internalQuery({
  args: {
    searchId: v.id("searches"),
    includeUnreplied: v.optional(v.boolean()),
  },
  returns: v.union(v.null(), v.any()),
  handler: async (ctx, { searchId, includeUnreplied }) => {
    const search = await ctx.db.get(searchId);
    if (!search) return null;
    const inquiries = await ctx.db
      .query("inquiries")
      .withIndex("by_search", (q) => q.eq("searchId", searchId))
      .collect();

    const answeredStatuses = ["replied", "clarifying", "answered"];
    const rows = [];
    for (const inquiry of inquiries) {
      if (
        includeUnreplied === false &&
        !answeredStatuses.includes(inquiry.status)
      ) {
        continue;
      }
      const facility = await ctx.db
        .query("facilities")
        .withIndex("by_ccn", (q) => q.eq("ccn", inquiry.ccn))
        .unique();
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

      rows.push({
        ccn: inquiry.ccn,
        name: inquiry.facilityName,
        // Federal record
        overallRating: facility?.overallRating || null,
        actualHarmCitations: harm.length,
        immediateJeopardyCitations: jeopardy.length,
        rnHoursWeekend: facility?.rnHoursWeekend ?? null,
        // What they told us
        status: inquiry.status,
        hasOpening: inquiry.hasOpening ?? null,
        monthlyCostLow: inquiry.monthlyCostLow ?? null,
        monthlyCostHigh: inquiry.monthlyCostHigh ?? null,
        waitlistWeeks: inquiry.waitlistWeeks ?? null,
        staffRatioNights: inquiry.staffRatioNights ?? null,
        tourOffered: inquiry.tourOffered ?? null,
        unanswered: inquiry.unanswered,
      });
    }

    return {
      family: {
        careLevel: careLevelPhrase(search.careLevel),
        budgetMax: search.budgetMax ?? null,
        mustHaves: search.mustHaves,
        zip: search.zip,
      },
      rows,
    };
  },
});

// =============================================================================
// The loop
// =============================================================================

/**
 * A reply arrived. Read it, decide, and write back if the family is owed more.
 *
 * The agent thread is per-inquiry and persists, so the second round is reasoned
 * about with the first round's exchange in front of it rather than in isolation.
 * That is the whole reason the Agent component is here rather than a bare model
 * call: this is a conversation, and it has a memory.
 */
export const handleReply = internalAction({
  args: { inquiryId: v.id("inquiries"), round: v.number() },
  returns: v.object({
    ran: v.boolean(),
    reason: v.string(),
    threadId: v.optional(v.string()),
    said: v.optional(v.string()),
  }),
  handler: async (
    ctx,
    { inquiryId, round },
  ): Promise<{
    ran: boolean;
    reason: string;
    threadId?: string;
    said?: string;
  }> => {
    const inquiry: InquiryState | null = await ctx.runQuery(
      internal.agentLoop.inquiryRounds,
      { inquiryId },
    );
    if (!inquiry) return { ran: false, reason: "no_such_inquiry" };

    // The reconciliation is scheduled BEFORE the agent runs, not after, so an
    // agent that throws, times out, or answers in prose instead of calling a
    // tool still leaves the family their answer. It covers BOTH failures — a
    // reply that was never read, and a follow-up that was never sent — because
    // the first one happened: a model that would not call a tool declared with
    // no arguments burned its steps, and four replies sat unread with nothing
    // to notice it. A net that only catches the second failure is not a net.
    await ctx.scheduler.runAfter(60_000, internal.email.ensureReplyHandled, {
      inquiryId,
      round,
    });

    let threadId = inquiry.agentThreadId ?? undefined;
    if (!threadId) {
      const created = await ombuds.createThread(ctx, {
        title: `${inquiry.facilityName} — ${inquiry.ccn}`,
      });
      threadId = created.threadId;
      await ctx.runMutation(internal.usage.linkThread, {
        threadId,
        searchId: inquiry.searchId,
        inquiryId,
        purpose: "inquiry",
      });
      await ctx.runMutation(internal.agentLoop.setAgentThread, {
        inquiryId,
        threadId,
      });
    }

    // No ids in the prompt: the tools are already bound to this conversation,
    // so there is nothing here for the model to copy down wrong.
    const prompt = [
      `A reply just arrived from ${inquiry.facilityName} (CCN ${inquiry.ccn}).`,
      `This is round ${round} of at most 2.`,
      "",
      "Read it and decide whether the family is still owed an answer.",
    ].join("\n");

    try {
      const result = await ombuds.generateText(
        ctx,
        { threadId },
        {
          prompt,
          tools: {
            lookupFacility,
            ...conversationTools(inquiryId, inquiry.searchId),
          },
        },
      );
      return {
        ran: true,
        reason: "agent_completed",
        threadId,
        said: result.text?.slice(0, 500),
      };
    } catch (error) {
      // Not fatal, by design. The reconciliation scheduled above will send the
      // follow-up if one is owed, so a bad minute from a provider costs us the
      // agent's reasoning, not the family's answer.
      console.error(`[agentLoop] agent turn failed for ${inquiryId}: ${error}`);
      return { ran: false, reason: `agent_failed: ${String(error).slice(0, 200)}` };
    }
  },
});

/** Remember which agent thread is holding this conversation open. */
export const setAgentThread = internalMutation({
  args: { inquiryId: v.id("inquiries"), threadId: v.string() },
  returns: v.null(),
  handler: async (ctx, { inquiryId, threadId }) => {
    await ctx.db.patch(inquiryId, { agentThreadId: threadId });
    return null;
  },
});

// =============================================================================
// Ranking
// =============================================================================

/**
 * Order the board against what this family actually said they need.
 *
 * The default sort on the board is a fixed rule — openings first, then harm,
 * then rating — which is right for a stranger and blunt for a person. This asks
 * the agent to weigh the same rows against a budget, a care level, and three
 * must-haves, and to say in one sentence why each one landed where it did.
 *
 * It is a separate entry point rather than part of the reply loop because it is
 * worth paying for once, when a family asks, rather than after every reply.
 */
export const rankSearch = action({
  args: { searchId: v.id("searches") },
  returns: v.object({
    ranked: v.boolean(),
    reason: v.string(),
    summary: v.optional(v.string()),
  }),
  handler: async (
    ctx,
    { searchId },
  ): Promise<{ ranked: boolean; reason: string; summary?: string }> => {
    const owned: boolean = await ctx.runQuery(api.searches.ownsSearch, { searchId });
    if (!owned) throw new Error("not your search");

    const { threadId } = await ombuds.createThread(ctx, {
      title: `Ranking — search ${searchId}`,
    });
    await ctx.runMutation(internal.usage.linkThread, {
      threadId,
      searchId,
      purpose: "ranking",
    });

    try {
      const result = await ombuds.generateText(
        ctx,
        { threadId },
        {
          tools: { lookupFacility, ...rankingTools(searchId) },
          prompt: [
            "Rank this family's shortlist.",
            "Call rankResults to get the rows, then reply with the facilities " +
              "in order, one line each: the name, and one short clause saying " +
              "why it is placed there. Weigh the family's stated budget, care " +
              "level and must-haves against both the federal inspection record " +
              "and what each facility said by email. Say plainly when a " +
              "facility has not answered yet rather than ranking it as if it " +
              "had. Give no advice and make no recommendation — describe what " +
              "the record and the replies show.",
          ].join("\n"),
        },
      );
      return { ranked: true, reason: "ok", summary: result.text };
    } catch (error) {
      console.error(`[agentLoop] ranking failed for ${searchId}: ${error}`);
      return { ranked: false, reason: String(error).slice(0, 300) };
    }
  },
});

// =============================================================================
// Adding a facility by hand
// =============================================================================

/**
 * "Ask this one too."
 *
 * A family reads one facility's inspection record properly and wants it on the
 * list. Same path the agent's `sendInquiry` tool takes, same send guard, same
 * letter.
 */
export const contactFacility = action({
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
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("not signed in");
    const owned: boolean = await ctx.runQuery(api.searches.ownsSearch, { searchId });
    if (!owned) throw new Error("not your search");
    return await ctx.runAction(internal.email.sendInquiryToFacility, {
      searchId,
      ccn,
    });
  },
});
