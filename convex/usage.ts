import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internalMutation, query } from "./_generated/server";
import { normalizeProviderId, priceUsd } from "./ai/provider";

/**
 * What this search cost us.
 *
 * No credits were provided for this hackathon and the budget is real
 * (CLAUDE.md section 10), so the number is not a vanity metric — it is the
 * thing that decides whether translations get cached, whether the agent loop
 * runs on the small model, and whether a bulk job is allowed to exist. Every
 * model call in the product lands in one table here, whether it went through
 * the Convex Agent component or through a direct structured call, and the total
 * is shown in a small footer under the board.
 *
 * The honest part is `priced`. We record tokens for every call; we record
 * dollars only for models we have a published rate for. A model we cannot price
 * shows up on screen as tokens with no dollar figure, never as $0.00.
 */

export const record = internalMutation({
  args: {
    searchId: v.optional(v.id("searches")),
    inquiryId: v.optional(v.id("inquiries")),
    threadId: v.optional(v.string()),
    purpose: v.string(),
    provider: v.string(),
    model: v.string(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    cachedInputTokens: v.number(),
    reasoningTokens: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const provider = normalizeProviderId(args.provider);
    const { costUsd, priced } = priceUsd(`${provider}:${args.model}`, {
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      cachedInputTokens: args.cachedInputTokens,
      reasoningTokens: args.reasoningTokens,
    });
    await ctx.db.insert("modelUsage", {
      ...args,
      provider,
      costUsd,
      priced,
      createdAt: Date.now(),
    });
    return null;
  },
});

/**
 * Attribute an agent-component call to the search it belongs to.
 *
 * The component's usage handler knows the thread but not the family, so this
 * walks back through `agentThreads`. A thread we have no record of is still
 * recorded — unattributed — rather than dropped: a call we cannot explain is
 * exactly the kind of spend we most want to see.
 */
export const recordForThread = internalMutation({
  args: {
    threadId: v.optional(v.string()),
    purpose: v.string(),
    provider: v.string(),
    model: v.string(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    cachedInputTokens: v.number(),
    reasoningTokens: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const link = args.threadId
      ? await ctx.db
          .query("agentThreads")
          .withIndex("by_thread", (q) => q.eq("threadId", args.threadId!))
          .unique()
      : null;

    // The component reports the adapter's id ("openai.responses"); the price
    // table is keyed on the short name. Normalise before both, so the ledger
    // reads consistently whichever path a call came in through.
    const provider = normalizeProviderId(args.provider);
    const { costUsd, priced } = priceUsd(`${provider}:${args.model}`, {
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      cachedInputTokens: args.cachedInputTokens,
      reasoningTokens: args.reasoningTokens,
    });

    await ctx.db.insert("modelUsage", {
      ...args,
      provider,
      searchId: link?.searchId,
      inquiryId: link?.inquiryId,
      costUsd,
      priced,
      createdAt: Date.now(),
    });
    return null;
  },
});

export const linkThread = internalMutation({
  args: {
    threadId: v.string(),
    searchId: v.id("searches"),
    inquiryId: v.optional(v.id("inquiries")),
    purpose: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("agentThreads")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .unique();
    if (existing) return null;
    await ctx.db.insert("agentThreads", { ...args, createdAt: Date.now() });
    return null;
  },
});

/**
 * The footer under the board: what this family's search has cost, broken down
 * by what the money was actually spent on.
 *
 * Reactive like everything else, so it ticks up while a campaign runs.
 */
export const spendForSearch = query({
  args: { searchId: v.id("searches") },
  returns: v.union(
    v.null(),
    v.object({
      calls: v.number(),
      inputTokens: v.number(),
      outputTokens: v.number(),
      cachedInputTokens: v.number(),
      totalTokens: v.number(),
      costUsd: v.number(),
      /** True when every call we counted had a published rate. */
      fullyPriced: v.boolean(),
      unpricedCalls: v.number(),
      byPurpose: v.array(
        v.object({
          purpose: v.string(),
          calls: v.number(),
          totalTokens: v.number(),
          costUsd: v.number(),
        }),
      ),
      models: v.array(v.string()),
    }),
  ),
  handler: async (ctx, { searchId }) => {
    const userId = await getAuthUserId(ctx);
    const search = await ctx.db.get(searchId);
    if (!userId || !search || search.userId !== userId) return null;

    const rows = await ctx.db
      .query("modelUsage")
      .withIndex("by_search", (q) => q.eq("searchId", searchId))
      .collect();

    const byPurpose = new Map<
      string,
      { purpose: string; calls: number; totalTokens: number; costUsd: number }
    >();
    const models = new Set<string>();

    let inputTokens = 0;
    let outputTokens = 0;
    let cachedInputTokens = 0;
    let costUsd = 0;
    let unpricedCalls = 0;

    for (const row of rows) {
      inputTokens += row.inputTokens;
      outputTokens += row.outputTokens;
      cachedInputTokens += row.cachedInputTokens;
      costUsd += row.costUsd;
      if (!row.priced) unpricedCalls += 1;
      models.add(`${row.provider}:${row.model}`);

      const bucket = byPurpose.get(row.purpose) ?? {
        purpose: row.purpose,
        calls: 0,
        totalTokens: 0,
        costUsd: 0,
      };
      bucket.calls += 1;
      bucket.totalTokens += row.inputTokens + row.outputTokens;
      bucket.costUsd += row.costUsd;
      byPurpose.set(row.purpose, bucket);
    }

    return {
      calls: rows.length,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      totalTokens: inputTokens + outputTokens,
      costUsd,
      fullyPriced: unpricedCalls === 0,
      unpricedCalls,
      byPurpose: [...byPurpose.values()].sort((a, b) => b.costUsd - a.costUsd),
      models: [...models].sort(),
    };
  },
});
