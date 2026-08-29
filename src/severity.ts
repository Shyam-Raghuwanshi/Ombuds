/**
 * Presentation rules for the scope/severity grid. CLAUDE.md section 8:
 * red is reserved exclusively for harm severity. If red appears anywhere in
 * this product, it means a resident was hurt.
 */

export type HarmLevel =
  | "minimal"
  | "potential"
  | "actual_harm"
  | "immediate_jeopardy";

export const HARM_LABEL: Record<HarmLevel, string> = {
  minimal: "No harm",
  potential: "Potential for harm",
  actual_harm: "Actual harm",
  immediate_jeopardy: "Immediate jeopardy",
};

/**
 * Only the two harm levels get colour. Everything below "actual harm" is
 * rendered in ordinary ink — a paperwork finding must not look like an injury.
 *
 * `surface-harm` on the jeopardy chip switches any focus ring inside it to
 * white: the focus blue sits at 1.02:1 against that red and would vanish.
 */
export const HARM_CHIP: Record<HarmLevel, string> = {
  minimal: "border-rule text-muted",
  potential: "border-rule text-muted",
  actual_harm: "border-harm-edge bg-harm-soft text-harm",
  immediate_jeopardy:
    "surface-harm border-harm-edge bg-harm-solid text-on-harm",
};

export const SPREAD_LABEL: Record<string, string> = {
  isolated: "Isolated",
  pattern: "Pattern",
  widespread: "Widespread",
};

export const PATTERN_LABEL: Record<string, string> = {
  clean: "No harm on record",
  isolated_incident: "One incident, corrected",
  improving: "Improving",
  recurring: "Repeating failures",
  severe_recurring: "Repeating failures with harm",
};

export function fmtDate(ms: number): string {
  if (!ms) return "date not published";
  return new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}
