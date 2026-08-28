import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateObject } from "ai";
import type { LanguageModel } from "ai";
import type { z } from "zod";

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
  | "facilityRanking"; // low volume, structured

const TIER: Record<Task, "small" | "large"> = {
  deficiencyTranslation: "small",
  facilityRiskSummary: "large",
  // Low volume — one call per facility — but the failure mode is attributing
  // another home's lawsuit to this one. That is worth the better model.
  facilityNewsScan: "large",
  emailReplyParse: "large",
  emailDraft: "large",
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

function languageModel(provider: Provider, id: string): LanguageModel {
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
}): Promise<{ object: T; model: string }> {
  const provider = activeProvider();
  const id = modelId(provider, TIER[args.task]);

  const { object } = await generateObject({
    model: languageModel(provider, id),
    schema: args.schema,
    schemaName: args.schemaName,
    schemaDescription: args.schemaDescription,
    system: args.system,
    prompt: args.prompt,
    temperature: 0.2,
    maxRetries: 2,
  });

  return { object: object as T, model: `${provider}:${id}` };
}
