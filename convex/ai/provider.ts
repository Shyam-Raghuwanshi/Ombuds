import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateObject } from "ai";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { z } from "zod";
import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

/**
 * The ONLY file in this codebase that names a model or imports a provider SDK.
 * See CLAUDE.md section 11. Nothing else may import `@ai-sdk/*`.
 *
 * Provider is chosen by the LLM_PROVIDER env var, never by editing code:
 *   LLM_PROVIDER=google   during the build
 *   LLM_PROVIDER=openai   from Sep 15 onward — this is what ships
 *
 * Both providers answer the same zod schema per task, so a swap either matches
 * the schema or fails loudly. It can never silently change the data shape.
 */

export type Provider = "openai" | "google";

/**
 * Tasks, and the tier each one runs at. CLAUDE.md section 10:
 * bulk repetitive work goes to the cheapest small model, low-volume work where
 * quality actually shows goes to the better one.
 */
export type Task =
  | "deficiencyTranslation" // high volume, highly repetitive, cached by (tag, severity)
  | "facilityRiskSummary" // one call per facility ever viewed — reasoning over a whole history
  | "facilityNewsScan" // deciding whether a news story is about THIS facility
  | "emailReplyParse" // messy human text, quality matters
  | "emailDraft" // a real family's voice
  | "agentLoop" // the tool-calling loop: reads a parse, decides whether to ask again
  | "facilityRanking"; // low volume, structured

const TIER: Record<Task, "small" | "large"> = {
  deficiencyTranslation: "small",
  facilityRiskSummary: "large",
  // Low volume — one call per facility — but the failure mode is attributing
  // another home's lawsuit to this one. That is worth the better model.
  facilityNewsScan: "large",
  emailReplyParse: "large",
  emailDraft: "large",
  // The loop itself only has to read a structured parse and choose a tool. The
  // prose it produces is written by emailDraft, which is on the large model, so
  // routing the loop to the small one costs nothing in quality and is what
  // makes a fifty-run rehearsal week affordable (CLAUDE.md section 10).
  agentLoop: "small",
  facilityRanking: "small",
};

/**
 * Model ids are overridable by env so the Sep 15 provider switch can never be
 * blocked by a renamed model. Defaults are the current small/large pair.
 */
const DEFAULT_MODELS: Record<Provider, { small: string; large: string }> = {
  openai: { small: "gpt-5-mini", large: "gpt-5" },
  google: { small: "gemini-3.5-flash-lite", large: "gemini-3.5-flash" },
};

function activeProvider(): Provider {
  const raw = (process.env.LLM_PROVIDER ?? "openai").toLowerCase();
  if (raw !== "openai" && raw !== "google") {
    throw new Error(
      `LLM_PROVIDER must be "openai" or "google", got "${raw}". ` +
        `Set it with: npx convex env set LLM_PROVIDER openai`,
    );
  }
  return raw;
}

function modelId(provider: Provider, tier: "small" | "large"): string {
  const override =
    tier === "small"
      ? process.env[provider === "openai" ? "OPENAI_MODEL_SMALL" : "GEMINI_MODEL_SMALL"]
      : process.env[provider === "openai" ? "OPENAI_MODEL_LARGE" : "GEMINI_MODEL_LARGE"];
  return override ?? DEFAULT_MODELS[provider][tier];
}

/**
 * Both adapters implement the v4 model spec, and that is deliberately the
 * declared type rather than the AI SDK's wider `LanguageModel` union: the
 * Convex Agent component only accepts a v4 model, and it should be this file
 * that fails to compile if a provider package is ever downgraded — not the
 * agent that silently loses its model.
 */
function languageModel(provider: Provider, id: string): LanguageModelV4 {
  if (provider === "openai") {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OPENAI_API_KEY is not set on this deployment. " +
          "Set it with: npx convex env set OPENAI_API_KEY sk-...",
      );
    }
    return createOpenAI({ apiKey })(id);
  }
  // Dev-time provider only. Never reachable when LLM_PROVIDER=openai.
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not set on this deployment. " +
        "Set it with: npx convex env set GEMINI_API_KEY ...",
    );
  }
  return createGoogleGenerativeAI({ apiKey })(id);
}

/**
 * Stable, greppable provenance string written onto every cached row, so we can
 * tell which provider produced a translation and clear the table on the switch.
 * e.g. "openai:gpt-5-mini"
 */
export function modelTag(task: Task): string {
  const provider = activeProvider();
  return `${provider}:${modelId(provider, TIER[task])}`;
}

/**
 * The model behind a task, as an AI SDK handle.
 *
 * Exported so the Convex Agent component can be constructed with it. This file
 * stays the only one that names a model or imports a provider SDK: `agent.ts`
 * asks for a task and gets back something opaque (CLAUDE.md section 11.1).
 */
export function resolveModel(task: Task): {
  provider: Provider;
  id: string;
  tag: string;
  model: LanguageModelV4;
} {
  const provider = activeProvider();
  const id = modelId(provider, TIER[task]);
  return {
    provider,
    id,
    tag: `${provider}:${id}`,
    model: languageModel(provider, id),
  };
}

// =============================================================================
// What it costs
// =============================================================================

/**
 * List prices in US dollars per million tokens, as configured for this
 * deployment. Keyed by the same `provider:model` tag we write for provenance.
 *
 * These are configuration, not a live feed: providers reprice, and a number
 * baked into a build goes stale silently. So two rules hold everywhere the
 * total is used —
 *
 *   1. `LLM_PRICES` (a JSON object of the same shape) overrides this table
 *      without a redeploy, so a price change is one `npx convex env set`.
 *   2. A model absent from the table is recorded with `priced: false` and its
 *      tokens are counted but its dollars are NOT. We would rather show a
 *      family "1.2M tokens, cost not priced" than a confident wrong number.
 */
const LIST_PRICES: Record<
  string,
  { input: number; cachedInput: number; output: number }
> = {
  "openai:gpt-5": { input: 1.25, cachedInput: 0.125, output: 10 },
  "openai:gpt-5-mini": { input: 0.25, cachedInput: 0.025, output: 2 },
  "google:gemini-3.5-flash": { input: 0.3, cachedInput: 0.075, output: 2.5 },
  "google:gemini-3.5-flash-lite": { input: 0.1, cachedInput: 0.025, output: 0.4 },
};

function priceTable(): typeof LIST_PRICES {
  const raw = process.env.LLM_PRICES;
  if (!raw) return LIST_PRICES;
  try {
    return { ...LIST_PRICES, ...(JSON.parse(raw) as typeof LIST_PRICES) };
  } catch (error) {
    console.error(`[provider] LLM_PRICES is not valid JSON, ignoring: ${error}`);
    return LIST_PRICES;
  }
}

/**
 * Map a provider id back onto the two names this file knows.
 *
 * The AI SDK reports the adapter's own id — `google.generative-ai`,
 * `openai.chat` — while our price table, our provenance strings, and the
 * `LLM_PROVIDER` env var all use the short name. Without this, calls made
 * through the Convex Agent component arrive under a name the price table has
 * never heard of and are silently recorded as unpriced: tokens counted,
 * dollars missing, and a cost figure on screen that is quietly too low.
 */
export function normalizeProviderId(raw: string): string {
  const head = raw.toLowerCase().split(/[.\/]/)[0];
  return head === "google" || head === "openai" ? head : raw;
}

export type TokenCounts = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
};

/**
 * Price one call. Returns `priced: false` when we have no rate for the model,
 * which the UI renders as an absence rather than as zero.
 *
 * Cached input is billed separately and much cheaper, so it is subtracted from
 * the input count rather than double-charged — getting this wrong would inflate
 * the figure on screen by roughly the size of our stable system prompts, which
 * are the largest part of every request (CLAUDE.md section 10).
 */
export function priceUsd(
  modelTagString: string,
  tokens: TokenCounts,
): { costUsd: number; priced: boolean } {
  const rate = priceTable()[modelTagString];
  if (!rate) return { costUsd: 0, priced: false };
  const uncachedInput = Math.max(0, tokens.inputTokens - tokens.cachedInputTokens);
  // Reasoning tokens are billed as output by both providers, and both already
  // include them in outputTokens, so they are reported but not added again.
  const costUsd =
    (uncachedInput * rate.input +
      tokens.cachedInputTokens * rate.cachedInput +
      tokens.outputTokens * rate.output) /
    1_000_000;
  return { costUsd, priced: true };
}

/**
 * The single entry point for every model call in the product.
 *
 * Structured output only — the caller supplies a zod schema and gets back a
 * validated object. No prose is ever parsed with a regex (CLAUDE.md section 9).
 *
 * `system` is passed separately from `prompt` and is deliberately identical for
 * every call of a given task, so the provider's cached-input pricing applies to
 * the long, stable half of the request (CLAUDE.md section 10).
 */
export async function generateStructured<T>(args: {
  task: Task;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  schemaName: string;
  schemaDescription?: string;
  /**
   * Pass the action's ctx to have the token usage of this call recorded. The
   * Convex Agent component records its own calls through a usage handler; this
   * is how the direct calls — drafting a letter, reading a reply — land in the
   * same ledger, so the figure a family sees is the whole cost of their search
   * and not the part that happened to go through the agent.
   */
  ctx?: ActionCtx;
  attribution?: {
    searchId?: Id<"searches">;
    inquiryId?: Id<"inquiries">;
  };
}): Promise<{ object: T; model: string }> {
  const provider = activeProvider();
  const id = modelId(provider, TIER[args.task]);
  const tag = `${provider}:${id}`;

  const { object, usage } = await generateObject({
    model: languageModel(provider, id),
    schema: args.schema,
    schemaName: args.schemaName,
    schemaDescription: args.schemaDescription,
    system: args.system,
    prompt: args.prompt,
    temperature: 0.2,
    maxRetries: 2,
  });

  if (args.ctx) {
    // Never let bookkeeping fail the work it is measuring.
    try {
      await args.ctx.runMutation(internal.usage.record, {
        ...args.attribution,
        purpose: args.task,
        provider,
        model: id,
        ...normalizeUsage(usage),
      });
    } catch (error) {
      console.error(`[provider] could not record usage for ${tag}: ${error}`);
    }
  }

  return { object: object as T, model: tag };
}

/**
 * The AI SDK reports every token count as optional, because not every provider
 * returns every field. Missing is recorded as zero and the row still lands, so
 * a provider that reports nothing shows up as a call we made rather than as a
 * call that never happened.
 */
export function normalizeUsage(usage: {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
}): TokenCounts {
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cachedInputTokens: usage.cachedInputTokens ?? 0,
    reasoningTokens: usage.reasoningTokens ?? 0,
  };
}
