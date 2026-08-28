import {
  CANONICAL_QUESTION,
  QUESTION_KEYS,
  careLevelPhrase,
  fillCanonical,
  type QuestionKey,
} from "./questions";

/**
 * Turning a model's draft into the letter that actually goes out.
 *
 * The model writes in the family's voice; this file decides what is allowed to
 * leave. The one guarantee it enforces is coverage: a letter never goes out
 * missing one of the five questions, no matter what came back from the model.
 * A dropped question would put a permanent blank on the board that looks like a
 * facility dodged something they were never asked.
 */

export type DraftQuestion = { key: string; text: string };

/**
 * Take whatever the model produced and return exactly the five questions, in
 * the fixed order, filling any slot the model dropped or malformed with the
 * canonical phrasing.
 *
 * Also drops duplicates: a model that answers the same key twice gets its first
 * attempt kept and the second discarded, rather than a letter that asks about
 * cost twice and never mentions staffing.
 */
export function normalizeQuestions(
  drafted: DraftQuestion[],
  careLevel: string,
  tourDates: string,
  wanted: readonly QuestionKey[] = QUESTION_KEYS,
): { questions: { key: QuestionKey; text: string }[]; filledFromCanonical: QuestionKey[] } {
  const seen = new Map<QuestionKey, string>();
  for (const q of drafted) {
    const key = q.key as QuestionKey;
    if (!wanted.includes(key)) continue;
    if (seen.has(key)) continue;
    const text = q.text?.trim();
    if (!text) continue;
    seen.set(key, text);
  }

  const filledFromCanonical: QuestionKey[] = [];
  const questions = wanted.map((key) => {
    const text = seen.get(key);
    if (text) return { key, text };
    filledFromCanonical.push(key);
    return { key, text: fillCanonical(key, careLevel, tourDates) };
  });

  return { questions, filledFromCanonical };
}

/**
 * Assemble the body. Numbered questions, because a numbered list is the single
 * biggest thing that makes a busy admissions coordinator answer all five
 * instead of the first one.
 */
export function assembleLetter(args: {
  opening: string;
  questions: { key: QuestionKey; text: string }[];
  closing: string;
  signOff: string;
}): string {
  const numbered = args.questions
    .map((q, i) => `${i + 1}. ${q.text}`)
    .join("\n");
  return [
    args.opening.trim(),
    numbered,
    args.closing.trim(),
    args.signOff.trim(),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * A last-resort letter, written without a model at all.
 *
 * If OpenAI is unreachable when a campaign starts we still send, because a
 * family waiting on twelve replies is worse off with an empty board than with
 * an unpersonalised letter. Plain, complete, and honest about nothing.
 */
export function fallbackLetter(args: {
  careLevel: string;
  tourDates: string;
  city: string;
  signOff: string;
}): { subject: string; opening: string; questions: { key: QuestionKey; text: string }[]; closing: string } {
  return {
    subject: "Availability and monthly cost",
    opening:
      `I am looking for ${careLevelPhrase(args.careLevel)} for my mother in ` +
      `the ${args.city} area, and I am trying to compare a few places ` +
      `honestly before we visit. Five quick questions if you have a moment:`,
    questions: QUESTION_KEYS.map((key) => ({
      key,
      text: fillCanonical(key, args.careLevel, args.tourDates),
    })),
    closing: "Thank you for your time.",
  };
}

export { CANONICAL_QUESTION };
