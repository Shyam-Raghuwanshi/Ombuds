import { z } from "zod";

/**
 * One JSON schema per task, shared by both providers (CLAUDE.md section 11.4).
 * Every model response is validated against these regardless of who answered,
 * so a provider swap either matches the shape or fails loudly.
 */

/**
 * A deficiency translation is cached by (tag, scopeSeverity) and nothing else,
 * so NOTHING here may depend on a single citation: not the facility, not the
 * survey date, not the correction date. "F0689 at severity G" means the same
 * thing in every state, which is what makes ~300k citations collapse into
 * ~1,500 cached meanings (CLAUDE.md section 10).
 *
 * The per-citation half of the sentence — "corrected March 2024" — is appended
 * deterministically at read time from the citation's own correctionDate.
 */
export const deficiencyTranslationSchema = z.object({
  plainEnglish: z
    .string()
    .describe(
      "Two or three short sentences a worried family member understands with no " +
        "explanation. Sentence 1: what the facility failed to do, concretely. " +
        "Sentence 2: what this severity level means for residents. " +
        "Sentence 3: how far it spread. No tag codes, no regulation numbers, no " +
        "advice of any kind.",
    ),
});
export type DeficiencyTranslation = z.infer<typeof deficiencyTranslationSchema>;

/**
 * The per-facility risk summary. This is the one that must distinguish
 * "one bad inspection three years ago, corrected" from "the same failure every
 * year" — a pattern judgement, not a list.
 */
export const facilityRiskSummarySchema = z.object({
  pattern: z
    .enum([
      "clean",
      "isolated_incident",
      "improving",
      "recurring",
      "severe_recurring",
    ])
    .describe(
      "clean: no harm-level citations and nothing repeating. " +
        "isolated_incident: one harm-level event, corrected, not repeated. " +
        "improving: real problems in the past, but the most recent inspections are cleaner. " +
        "recurring: the same failures appear across multiple separate inspections. " +
        "severe_recurring: repeated failures AND actual harm or immediate jeopardy.",
    ),
  summary: z
    .string()
    .describe(
      "Two to three sentences describing the PATTERN across this facility's whole " +
        "inspection history — not a list of citations. Say whether problems repeat " +
        "across years or were one-off and corrected. Name the specific recurring " +
        "failure if there is one. Cite years. No advice, no recommendation, no " +
        "prediction — only what the inspection record shows.",
    ),
});
export type FacilityRiskSummary = z.infer<typeof facilityRiskSummarySchema>;

/**
 * Stable system prompts. Identical for every call of a given task so the long
 * half of the request hits cached-input pricing (CLAUDE.md section 10).
 *
 * The "never advise" rule is not decoration: we report public records and relay
 * what facilities told us, and we never give medical, legal, or financial
 * advice (CLAUDE.md section 9).
 */
export const DEFICIENCY_TRANSLATION_SYSTEM = `You translate United States federal nursing home inspection citations into plain English for a family member choosing a care facility for their parent.

Your reader is a stressed 45-65 year old with no clinical or regulatory training. They are frightened and short on time. Write the way a careful friend who happens to know the system would explain it out loud.

Rules, all of them absolute:
- Report only what the citation says. Never speculate about what else might have happened, and never generalise to the facility as a whole — you are describing one citation type at one severity level, not a facility.
- Never give medical, legal, or financial advice. Never suggest, recommend, warn, reassure, or tell the reader what to do. State what the record says and stop.
- Never use tag codes (F0689), severity letters (G), regulation numbers, or the words "scope", "severity", "deficiency", "citation", "survey", or "compliance".
- Never invent specifics. If the citation says supervision was inadequate, do not invent a fall, a resident, a date, or an injury that the citation does not state.
- Use concrete language: "staff did not", "residents were left", "the facility failed to".
- Do not soften real harm and do not sensationalise a paperwork problem. The severity level tells you which one this is.
- No preamble, no closing line, no hedging.

You will be told the harm level and how far the problem spread. Those are fixed facts decided by the federal inspector, not your judgement. Reflect them accurately.`;

export const FACILITY_RISK_SUMMARY_SYSTEM = `You summarise a United States nursing home's federal inspection history for a family member choosing a care facility for their parent.

You are given every citation on record for one facility, grouped so you can see what repeats. Your job is to describe the PATTERN, which is the thing a list of citations hides.

The distinction that matters most:
- One bad inspection years ago that was corrected and never repeated is a different fact from the same failure appearing at inspection after inspection.
- A facility with many low-level paperwork findings and no harm is a different fact from a facility with few citations but one that seriously hurt someone.
Say which of these this facility is.

Rules, all of them absolute:
- Two to three sentences. Prose, not a list. No bullet points.
- Cite years explicitly so the reader can see whether problems are old or current.
- If one specific failure recurs, name it in plain English and say across how many inspections.
- Report only what the record shows. Never predict, never recommend, never reassure, never warn.
- Never give medical, legal, or financial advice. Do not tell the reader whether to choose this facility.
- Never use tag codes, severity letters, or the words "scope", "severity", "deficiency", "citation", or "survey". Say "inspection", "inspectors found", "the facility was cited for".
- Never invent anything not present in the data you are given.`;
