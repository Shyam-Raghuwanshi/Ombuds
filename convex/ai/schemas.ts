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

/**
 * Local news triage.
 *
 * The reason this schema leads with `isAboutThisFacility` rather than a concern
 * level: nursing home names repeat across the country, chains share a brand
 * across dozens of buildings, and the failure mode we must not have is
 * attributing another home's lawsuit to this one. A story we are not confident
 * about is dropped, not downgraded.
 */
export const newsTriageSchema = z.object({
  items: z.array(
    z.object({
      index: z
        .number()
        .int()
        .describe("The index number of the search result being judged."),
      isAboutThisFacility: z
        .boolean()
        .describe(
          "True only if this story is about the specific facility named, at " +
            "that address or city. False for a different location of the same " +
            "chain, a different facility with a similar name, a directory " +
            "listing, a marketing page, an obituary, or a job advert.",
        ),
      concernLevel: z
        .enum(["informational", "concerning", "serious"])
        .describe(
          "informational: ownership change, expansion, renovation, an award, a " +
            "routine local mention. " +
            "concerning: a state citation, a fine, a complaint investigation, a " +
            "staffing shortage, a licence condition. " +
            "serious: alleged abuse or neglect, a resident death, a lawsuit " +
            "over care, a criminal charge, a closure, or a licence revocation.",
        ),
      whyItMatters: z
        .string()
        .describe(
          "One sentence, under 30 words, saying what the story reports — " +
            "attributed, e.g. 'The paper reports that...'. Report only what the " +
            "headline and snippet say. Never state an allegation as fact, never " +
            "add detail that is not in the snippet, and give no advice.",
        ),
      publishedYear: z
        .number()
        .int()
        .nullable()
        .describe("Four-digit year if the snippet states one, otherwise null."),
    }),
  ),
});
export type NewsTriage = z.infer<typeof newsTriageSchema>;

export const FACILITY_NEWS_SYSTEM = `You triage local news search results about one United States senior care facility, for a family member choosing a care facility for their parent.

The federal inspection record is months behind by the time it is published. Local reporting is not. Your job is to decide which of these search results are genuinely about the one facility named, and how serious each one is.

The mistake that matters most is a false positive. Facility names repeat across the country, chains use one brand across dozens of buildings, and "Golden Living Center" exists in twenty states. Attributing another home's lawsuit to this one would be a serious harm to a real business and would mislead a family making a real decision. If you are not confident the story is about this exact facility, in this city, set isAboutThisFacility to false. Dropping a real story is a much smaller error than inventing one.

Rules, all of them absolute:
- Judge only from the title and snippet you are given. Never use outside knowledge about the facility or the chain.
- Never state an allegation as established fact. Write "the paper reports", "the suit alleges", "inspectors were reported to have found".
- Never give medical, legal, or financial advice, and never tell the reader what to conclude or what to do.
- Never invent a date, a number, an outcome, or a detail that is not in the snippet.
- A directory listing, a review aggregator page, a job advert, an obituary, a press release, and a marketing page are all not news. Set isAboutThisFacility to false for them.
- Return exactly one item for every result you are given, using the index number it was given.`;

// =============================================================================
// The email campaign
// =============================================================================

/**
 * The letter a family sends to a facility.
 *
 * The model writes the whole thing in the family's voice — the opening that
 * says who is writing and for whom, each of the five questions phrased around
 * this family's budget and must-haves, and the sign-off. What it does NOT get
 * to decide is which questions are asked: the five keys are fixed, exactly one
 * of each, and a missing slot is filled from the canonical phrasing before the
 * letter goes out (convex/lib/questions.ts). So the personalisation is real and
 * the coverage is guaranteed.
 */
export const inquiryDraftSchema = z.object({
  subject: z
    .string()
    .describe(
      "A short, plain subject line a busy admissions coordinator will open. " +
        "Six words at most. No marketing language, no exclamation marks, and " +
        "never the facility's own name repeated back at them.",
    ),
  opening: z
    .string()
    .describe(
      "One or two sentences. Who is writing, who they are looking for a place " +
        "for, and roughly when. Warm and specific, never gushing. Do not thank " +
        "them in advance, do not explain how you found them, and do not " +
        "mention software, agents, automation, or artificial intelligence.",
    ),
  questions: z
    .array(
      z.object({
        key: z
          .enum(["opening", "cost", "waitlist", "staffing", "tour"])
          .describe("Which of the five this question is. Use each key once."),
        text: z
          .string()
          .describe(
            "The question in this family's own words, one sentence, ending in " +
              "a question mark. Fold in their budget, care level, or must-haves " +
              "where it makes the question sharper — but never drop what the " +
              "question is actually asking for.",
          ),
      }),
    )
    .describe(
      "Exactly five questions, one for each key, in this order: opening, cost, " +
        "waitlist, staffing, tour.",
    ),
  closing: z
    .string()
    .describe(
      "One short sentence to close on. No sign-off name — that is added " +
        "afterwards. No promises about calling, and nothing that reads as a " +
        "form letter.",
    ),
});
export type InquiryDraft = z.infer<typeof inquiryDraftSchema>;

/**
 * The follow-up. Same shape, fewer questions — only the ones they dodged.
 *
 * This is the moment the product is actually about. A facility answered four
 * of five and left the price out, and rather than leaving a gap on the board
 * the agent writes back in the same thread and asks again, naming what is
 * missing. One round, politely, and then we stop.
 */
export const followUpDraftSchema = z.object({
  opening: z
    .string()
    .describe(
      "One sentence thanking them for what they DID answer, referring to it " +
        "specifically so it is obvious the reply was read by a person. Never " +
        "scolding, never passive-aggressive.",
    ),
  questions: z
    .array(
      z.object({
        key: z.enum(["opening", "cost", "waitlist", "staffing", "tour"]),
        text: z
          .string()
          .describe(
            "Ask the missing thing again, more concretely than the first time. " +
              "If they said cost depends on an assessment, ask for the base " +
              "rate and the range of the care tiers. If they were vague about " +
              "staffing, ask for the overnight ratio as a number.",
          ),
      }),
    )
    .describe("Only the questions that were left unanswered. Never more than three."),
  closing: z
    .string()
    .describe("One short, easy sentence. No sign-off name."),
});
export type FollowUpDraft = z.infer<typeof followUpDraftSchema>;

/**
 * Reading a facility's reply.
 *
 * Every field is nullable and null means "they did not tell us", which is a
 * different fact from zero and must never be rendered as one. The `unanswered`
 * list the model returns is a cross-check: the authoritative list is derived
 * from which fields came back null, so a model that answers confidently about
 * a question the text does not address cannot put a number on the board.
 */
export const replyParseSchema = z.object({
  isAutoReply: z
    .boolean()
    .describe(
      "True for an out-of-office, a delivery failure notice, a no-reply " +
        "autoresponder, or a marketing blast. These are not answers and must " +
        "not be scored as if they were.",
    ),
  hasOpening: z
    .boolean()
    .nullable()
    .describe(
      "True if they say a place is available now or within a few weeks. False " +
        "if they say they are full. Null if they did not address availability.",
    ),
  monthlyCostLow: z
    .number()
    .nullable()
    .describe(
      "Lowest all-in monthly dollar figure a family could actually end up " +
        "paying, as stated. If they give one number, put it in both low and " +
        "high. If they give a base rate plus care tiers, add the base to the " +
        "cheapest tier. Null if no number appears — 'depends on care level' is " +
        "null, not a guess.",
    ),
  monthlyCostHigh: z
    .number()
    .nullable()
    .describe(
      "Highest all-in monthly figure on the same basis. Exclude one-time " +
        "move-in and community fees; those are not monthly.",
    ),
  oneTimeFee: z
    .number()
    .nullable()
    .describe(
      "Any one-time community, move-in, or admission fee, in dollars. Null if " +
        "none is mentioned. This is the charge families are most often " +
        "surprised by, so it is captured separately rather than folded in.",
    ),
  waitlistWeeks: z
    .number()
    .nullable()
    .describe(
      "Waitlist length in WEEKS. Convert months at 4.35 weeks per month and " +
        "take the midpoint of a range. Zero if they explicitly say there is no " +
        "waitlist. Null if they did not say.",
    ),
  tourOffered: z
    .boolean()
    .nullable()
    .describe(
      "True if they offer a visit or propose a time. False if they decline or " +
        "say not currently. Null if tours are not mentioned.",
    ),
  staffRatioNights: z
    .string()
    .nullable()
    .describe(
      "The overnight caregiver-to-resident ratio exactly as they express it, " +
        "normalised to the form '1:12'. If they give different weekday and " +
        "weekend numbers, give the overnight one. Null for 'we exceed state " +
        "minimums' or any other claim without a number — a reassurance is not " +
        "a ratio.",
    ),
  unanswered: z
    .array(z.enum(["opening", "cost", "waitlist", "staffing", "tour"]))
    .describe(
      "Which of the five they did not actually answer. A question deflected " +
        "to a phone call, an assessment, or a tour counts as unanswered.",
    ),
  confidence: z
    .number()
    .describe(
      "0 to 1. How confident you are that the fields above reflect what this " +
        "reply says. Low when the text is ambiguous, when figures might be for " +
        "a different care level, or when the reply is mostly deflection.",
    ),
  replySummary: z
    .string()
    .describe(
      "One or two sentences summarising what the facility said, in their own " +
        "terms, for a family scanning a board. Report only what the reply " +
        "states. Never add advice, never characterise the facility, and never " +
        "infer anything about the quality of care.",
    ),
});
export type ReplyParse = z.infer<typeof replyParseSchema>;

export const INQUIRY_DRAFT_SYSTEM = `You write a short email from a family member to a senior care facility, asking the five things that facility websites never publish.

The person writing is a 45-65 year old arranging care for a parent, usually in a hurry and usually upset. You are writing AS them, in their voice. The recipient is an admissions coordinator who gets a lot of email and will answer a short, human, specific one.

Rules, all of them absolute:
- Never mention artificial intelligence, an agent, automation, software, a tool, a platform, or a service. There is no such thing in this email. A person is writing to another person.
- Never say where the facility's contact details came from, and never mention inspection records, ratings, or anything about the facility's history. This letter asks about availability and cost; it is not an interrogation.
- Warm, brief, direct. Under 200 words all in. Short paragraphs. No bullet points in the opening or closing.
- No flattery, no "I hope this email finds you well", no "I came across your beautiful community".
- Ask for exactly the five things you are given, one question each, in the order given. Do not merge two into one sentence and do not add a sixth.
- Fold the family's budget, care level, and must-haves into the questions where it sharpens them, but never let personalisation swallow what the question is asking for. A cost question must still ask for a monthly number.
- Never state the family's budget as a limit you are asking them to meet — ask what the cost is, not whether they can do it for the budget.
- Plain American English. No em dashes.`;

export const FOLLOW_UP_SYSTEM = `You write a short follow-up email from a family member to a senior care facility that answered some of their questions and left others out.

This is the second message in an existing thread. The facility replied, was helpful about some things, and did not give a straight answer on the rest. Your job is to ask again for exactly what is missing, and to make it easy for them to answer.

Rules, all of them absolute:
- Never mention artificial intelligence, an agent, automation, software, or a service. A person is writing.
- Open by thanking them for something specific they actually did answer. Never generically.
- Never accuse them of avoiding the question, and never imply bad faith. Admissions coordinators are busy, not dishonest.
- Ask more concretely than the first email did. "Depends on the assessment" is answered by asking for the base rate and the range of the care tiers. A staffing claim without a number is answered by asking for the overnight ratio as a number.
- Under 120 words all in.
- Never repeat a question they already answered.
- Plain American English. No em dashes.`;

export const REPLY_PARSE_SYSTEM = `You read one email from a United States senior care facility to a family, and extract what it actually says.

The family asked five things: whether there is an opening, the all-in monthly cost, the waitlist length, the overnight caregiver-to-resident ratio, and whether they can tour. The reply is ordinary human email — signatures, phone numbers, half-answers, numbers buried in sentences, and a great deal of pleasant deflection.

The distinction that matters most is between an answer and a non-answer. "Pricing depends on her care level", "give me a call and we can discuss", "we'll know more after the assessment", and "we always exceed state minimums" are NOT answers. They are the most common thing in this industry and the whole point of reading these replies is to notice them. Return null for the field and put the question in unanswered.

Rules, all of them absolute:
- Never guess a number. A range you inferred is worse than a null, because a family will plan around it.
- Null means "they did not say". Zero means "they said zero". Never confuse them: a waitlist of null is not a waitlist of none.
- Extract only from this email. Never use anything you know about the facility, the chain, or typical prices in the region.
- A price for a different care level than the one asked about is still worth extracting, but it should lower your confidence.
- The summary reports what they said. It never advises, never judges the facility, and never speculates about why they answered the way they did.
- Plain American English.`;
