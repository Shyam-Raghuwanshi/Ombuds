/**
 * The federal scope/severity grid. A citation carries one letter, A-L, and that
 * single letter encodes two independent things: how much harm happened, and how
 * far it spread. CLAUDE.md section 6.
 *
 *            isolated   pattern   widespread
 *   IJ          J          K          L
 *   harm        G          H          I
 *   potential   D          E          F
 *   minimal     A          B          C
 *
 * G and above is the number families actually need. J and above is a red banner.
 */

export type HarmLevel =
  | "minimal"
  | "potential"
  | "actual_harm"
  | "immediate_jeopardy";

export type Spread = "isolated" | "pattern" | "widespread";

const HARM_BY_LETTER: Record<string, HarmLevel> = {
  A: "minimal", B: "minimal", C: "minimal",
  D: "potential", E: "potential", F: "potential",
  G: "actual_harm", H: "actual_harm", I: "actual_harm",
  J: "immediate_jeopardy", K: "immediate_jeopardy", L: "immediate_jeopardy",
};

const SPREAD_BY_LETTER: Record<string, Spread> = {
  A: "isolated", D: "isolated", G: "isolated", J: "isolated",
  B: "pattern", E: "pattern", H: "pattern", K: "pattern",
  C: "widespread", F: "widespread", I: "widespread", L: "widespread",
};

export function harmLevelFor(scopeSeverity: string): HarmLevel {
  const harm = HARM_BY_LETTER[scopeSeverity.trim().toUpperCase()];
  if (!harm) throw new Error(`Unknown scope/severity code: "${scopeSeverity}"`);
  return harm;
}

export function spreadFor(scopeSeverity: string): Spread {
  const spread = SPREAD_BY_LETTER[scopeSeverity.trim().toUpperCase()];
  if (!spread) throw new Error(`Unknown scope/severity code: "${scopeSeverity}"`);
  return spread;
}

export function isValidScopeSeverity(code: string): boolean {
  return code.trim().toUpperCase() in HARM_BY_LETTER;
}

export type RiskPattern =
  | "clean"
  | "isolated_incident"
  | "improving"
  | "recurring"
  | "severe_recurring";

/**
 * Hold the model's one-word pattern to the record it was written from.
 *
 * The pattern is shown as a label beside a real facility's name, so it is a
 * claim, and a model-chosen label must not contradict the federal counts on the
 * same card. It did: a facility with an actual-harm fall was labelled "clean",
 * which the screen renders as "No harm on record". The counts are the record;
 * the label follows them.
 */
export function reconcileRiskPattern(
  pattern: RiskPattern,
  harmFindings: number,
): RiskPattern {
  if (harmFindings > 0 && pattern === "clean") {
    return harmFindings === 1 ? "isolated_incident" : "severe_recurring";
  }
  if (harmFindings === 0 && pattern === "severe_recurring") return "recurring";
  if (harmFindings === 0 && pattern === "isolated_incident") return "clean";
  return pattern;
}

/** Rank for sorting worst-first. */
export const HARM_RANK: Record<HarmLevel, number> = {
  minimal: 0,
  potential: 1,
  actual_harm: 2,
  immediate_jeopardy: 3,
};

/**
 * Deterministic English for the letter itself. This is a lookup, not a model
 * call — the meaning of "G" is fixed by federal regulation, so paying an LLM to
 * restate it would be both wasteful and less reliable.
 */
export const HARM_PHRASE: Record<HarmLevel, string> = {
  minimal: "No harm occurred, and the potential for harm was minimal.",
  potential: "No resident was harmed, but there was potential for more than minimal harm.",
  actual_harm: "This caused actual harm.",
  immediate_jeopardy:
    "This placed residents in immediate jeopardy — serious injury or death was likely.",
};

export const SPREAD_PHRASE: Record<Spread, string> = {
  isolated: "Isolated incident",
  pattern: "Part of a pattern",
  widespread: "Widespread across the facility",
};

/**
 * CMS publishes dates as "2026-03-12". Parse to a UTC timestamp; return
 * undefined for the empty string CMS uses instead of null.
 */
export function parseCmsDate(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const ms = Date.parse(`${trimmed}T00:00:00Z`);
  return Number.isNaN(ms) ? undefined : ms;
}

/** "March 2024" — the form the family-facing sentence uses. */
export function monthYear(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** "Mar 12, 2024" — the provenance line under every CMS figure. */
export function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Tag format is prefix + zero-padded number: prefix "F" + number "0656" is
 * "F0656", never "F656". CLAUDE.md section 6, fact 2.
 */
export function normalizeTag(prefix: string, number: string): string {
  const p = prefix.trim().toUpperCase();
  const n = number.trim().padStart(4, "0");
  return `${p}${n}`;
}
