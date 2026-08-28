/**
 * The five questions.
 *
 * These are the things that are never published anywhere. CMS tells a family
 * whether a facility is safe; nothing tells them whether it is available, what
 * it actually costs, or who is on the floor at 3am. The only way to find out is
 * to ask, which is what this product does.
 *
 * The set is closed and ordered on purpose. Every inquiry asks all five, in
 * this order, so that a reply can be scored against a fixed rubric and a
 * dodged question is visible rather than merely absent. The model may rephrase
 * a question in the family's voice; it may never drop one, add one, or reorder
 * them (CLAUDE.md section 4).
 */

export const QUESTION_KEYS = [
  "opening",
  "cost",
  "waitlist",
  "staffing",
  "tour",
] as const;

export type QuestionKey = (typeof QUESTION_KEYS)[number];

/**
 * Short labels for the board. A family scanning twelve rows needs to see which
 * question was dodged without reading a sentence.
 */
export const QUESTION_LABEL: Record<QuestionKey, string> = {
  opening: "Opening",
  cost: "Monthly cost",
  waitlist: "Waitlist",
  staffing: "Night staffing",
  tour: "Tour",
};

/**
 * The canonical phrasing, used verbatim whenever the model fails to produce a
 * question for a slot. `<careLevel>` and `<dates>` are substituted before send.
 * This is the guarantee that all five are always asked even if a draft comes
 * back short — we never send an inquiry missing a question.
 */
export const CANONICAL_QUESTION: Record<QuestionKey, string> = {
  opening: "Do you currently have an opening for <careLevel>?",
  cost:
    "What is the all-in monthly cost, including any care-level surcharges or " +
    "one-time fees?",
  waitlist: "If there is a waitlist, how long is it right now?",
  staffing:
    "What is the caregiver-to-resident ratio on nights and at weekends?",
  tour: "Could we come and tour <dates>?",
};

/** Plain-English care level, for the letter rather than for the database. */
export const CARE_LEVEL_PHRASE: Record<string, string> = {
  independent: "independent living",
  assisted: "assisted living",
  memory: "memory care",
  skilled: "skilled nursing",
};

export function careLevelPhrase(careLevel: string): string {
  return CARE_LEVEL_PHRASE[careLevel] ?? careLevel;
}

/**
 * Fill the two placeholders. Kept here rather than at the call site so the
 * canonical text and its substitutions can never drift apart.
 */
export function fillCanonical(
  key: QuestionKey,
  careLevel: string,
  tourDates: string,
): string {
  return CANONICAL_QUESTION[key]
    .replace("<careLevel>", careLevelPhrase(careLevel))
    .replace("<dates>", tourDates);
}

/**
 * A natural two-weekend window, computed from the send date rather than
 * hardcoded, so a demo recorded in September does not offer a date in August.
 */
export function tourWindow(now: number): string {
  const first = new Date(now);
  // Next Saturday, or the one after if we are already at the weekend.
  const daysToSaturday = (6 - first.getUTCDay() + 7) % 7 || 7;
  first.setUTCDate(first.getUTCDate() + daysToSaturday);
  const second = new Date(first);
  second.setUTCDate(second.getUTCDate() + 7);
  const fmt = (d: Date) =>
    d.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    });
  return `${fmt(first)} or ${fmt(second)}`;
}
