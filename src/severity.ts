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
 */
export const HARM_CHIP: Record<HarmLevel, string> = {
  minimal:
    "border-[#d8dce1] text-[#5b6570] dark:border-[#2b3236] dark:text-[#9aa4ad]",
  potential:
    "border-[#d8dce1] text-[#5b6570] dark:border-[#2b3236] dark:text-[#9aa4ad]",
  actual_harm:
    "border-[#b3241c] text-[#b3241c] bg-[#fdf0ef] dark:bg-[#2a1210] dark:text-[#ff8a80] dark:border-[#7a1410]",
  immediate_jeopardy:
    "border-[#7a1410] bg-[#b3241c] text-white dark:bg-[#7a1410] dark:text-white",
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
