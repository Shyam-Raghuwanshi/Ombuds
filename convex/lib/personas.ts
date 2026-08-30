import type { QuestionKey } from "./questions";

/**
 * The seeded facility personas (CLAUDE.md section 7.1).
 *
 * We never email real facilities, so the other side of every demo conversation
 * is played from an inbox we control. These replies are hand-written rather
 * than model-generated, for three reasons:
 *
 *  1. The parser must be tested against text it did not write. If the same
 *     model both wrote and read the reply, a clean parse would prove nothing.
 *  2. The demo has to behave the same way on camera as it did in rehearsal.
 *  3. It costs nothing, and the money goes on translating inspection records.
 *
 * They are deliberately messy in the way real admissions email is messy:
 * signatures, phone numbers, half-answers, "give me a call and we can discuss",
 * a price buried in a sentence rather than stated as a number.
 *
 * The set spans the four outcomes a family actually meets — a real opening, a
 * long waitlist, a dodge, and a dead address — plus one that answers on money
 * and goes quiet on staffing, which is where the federal staffing record earns
 * its place next to the facility's own claim.
 */

export type PersonaKey =
  | "has_opening"
  | "waitlisted"
  | "dodges_pricing"
  | "dodges_staffing"
  | "bounces"
  | "silent";

export type PersonaReply = {
  subject?: string;
  body: string;
};

export type Persona = {
  key: PersonaKey;
  /** Shown in the UI next to the simulated badge, so nothing is disguised. */
  label: string;
  /** Never replies at all — the address is dead or nobody is reading it. */
  bounces?: boolean;
  /** Replies to nothing; used by the 72-hour nudge sweep. */
  silent?: boolean;
  /**
   * Which of the five this persona leaves unanswered on the first round. Used
   * only to seed the demo; the real `unanswered` list on an inquiry is always
   * derived from what the parser actually found in the text.
   */
  dodgesFirstRound: QuestionKey[];
  /** Round 1: the reply to the family's opening letter. */
  first: (ctx: PersonaContext) => PersonaReply;
  /** Round 2: the reply to our follow-up. Absent means they stay quiet. */
  second?: (ctx: PersonaContext) => PersonaReply;
};

export type PersonaContext = {
  facilityName: string;
  careLevelPhrase: string;
  /** Seeded from the inquiry id so a given row reads the same way every run. */
  variant: number;
};

const pick = <T,>(options: T[], variant: number): T =>
  options[variant % options.length];

/** A real person's sign-off, with the small inconsistencies real ones have. */
function signature(name: string, title: string, facilityName: string): string {
  return `\n\n${name}\n${title}\n${facilityName}`;
}

export const PERSONAS: Record<PersonaKey, Persona> = {
  // -------------------------------------------------------------------------
  // The good outcome. Answers all five, plainly. This is what a family hopes
  // for and almost never gets on the first email.
  // -------------------------------------------------------------------------
  has_opening: {
    key: "has_opening",
    label: "Answered in full",
    dodgesFirstRound: [],
    first: ({ facilityName, careLevelPhrase, variant }) => ({
      body: pick(
        [
          `Hi,\n\nThanks for reaching out, and I'm sorry you're going through this — it's a lot to sort out at once.\n\nWe do have one private room open in ${careLevelPhrase} right now, and a second one coming free at the end of the month. All-in it runs $6,200 a month. That's the room, all meals, housekeeping and laundry, and the standard care package — there's no separate care-level surcharge here, which I know is unusual. The only extras are salon and any medications billed through the pharmacy.\n\nNo waitlist at the moment for that room type.\n\nOvernight we run one caregiver to twelve residents on the memory side and one to sixteen on the main floor, with a licensed nurse in the building 24/7. Weekends are the same ratio as weekdays.\n\nI have Saturday morning free if you'd like to come and see it — 10am or 11am both work. Just let me know and I'll put it in the book.` +
            signature("Denise Alvarez", "Director of Admissions", facilityName),
          `Good morning,\n\nHappy to help. Yes — we have availability in ${careLevelPhrase}. One room is open now (semi-private) and a private studio frees up in about two weeks.\n\nCost: semi-private is $5,850/month, private studio is $6,400/month. Both are all-inclusive including the care tier — meals, laundry, activities, and nursing oversight. We don't do point-system surcharges.\n\nThere's no waitlist right now.\n\nStaffing overnight is 1:12, and 1:10 on the weekend day shift. An RN is on site around the clock.\n\nSaturday works for a tour, or Sunday afternoon if that's easier. Give me a time and I'll be here.` +
            signature("Marcus Bell", "Admissions Coordinator", facilityName),
        ],
        variant,
      ),
    }),
  },

  // -------------------------------------------------------------------------
  // Honest, and the answer is no. Still worth having on the board: a family
  // needs to know a place is six months out before they fall in love with it.
  // -------------------------------------------------------------------------
  waitlisted: {
    key: "waitlisted",
    label: "Waitlisted",
    dodgesFirstRound: [],
    first: ({ facilityName, careLevelPhrase, variant }) => ({
      body: pick(
        [
          `Hello,\n\nThank you for writing. I wish I had better news — we don't have anything open in ${careLevelPhrase} at the moment and our waitlist is running about six months. It has been that long since the spring.\n\nFor when a room does come up: our rate is $7,100 a month all in, which includes the care assessment tier. There is a $2,500 one-time community fee on move-in.\n\nOvernight staffing is one caregiver to fourteen residents, and we have an LVN on every shift.\n\nYou're very welcome to tour even while you're on the list — most families do, so they can decide whether it's worth the wait. Saturdays are usually quiet, so that would be a good morning to come.` +
            signature("Patricia Nwosu", "Community Relations", facilityName),
          `Hi there,\n\nWe're full right now. Realistically the wait for ${careLevelPhrase} is 5-6 months — I don't want to tell you eight weeks and have that not be true.\n\nPricing when a spot opens: $6,900/month all-in. That covers care at any level, so it doesn't go up if your mother's needs change. One-time move-in fee of $2,000.\n\nNights we staff 1:14. Weekend days are 1:11.\n\nWe do tours Saturday mornings and I'd genuinely encourage it even at this stage — it puts you further up the list if you've been in.` +
            signature("Ray Kaminski", "Admissions", facilityName),
        ],
        variant,
      ),
    }),
  },

  // -------------------------------------------------------------------------
  // The one the whole product is built for. Warm, helpful-sounding, and it
  // does not contain a price. "It depends on her care level" is the single
  // most common non-answer in this industry, and it is what forces a family
  // onto the phone where the number can be negotiated upward.
  //
  // Our agent notices the gap and writes back, in-thread, on its own. Round two
  // produces the number.
  // -------------------------------------------------------------------------
  dodges_pricing: {
    key: "dodges_pricing",
    label: "Dodged the price",
    dodgesFirstRound: ["cost"],
    first: ({ facilityName, careLevelPhrase, variant }) => ({
      body: pick(
        [
          `Hi,\n\nThanks so much for thinking of us. We do have an opening in ${careLevelPhrase} — one room came available last week.\n\nOn cost, it really depends on her care level. Every resident gets a nursing assessment when they move in and the monthly rate is built from that, so I can't quote you a number sight unseen. Once we've met her I can put an exact figure in writing.\n\nNo waitlist for that room.\n\nWe'd love to have you visit — Saturday or Sunday, whatever suits. Afternoons are best.\n\nGive me a call and we can talk it through properly.` +
            signature("Sharon Whitfield", "Director of Admissions", facilityName),
          `Good afternoon,\n\nYes, we have availability in ${careLevelPhrase} at the moment.\n\nOur pricing is based on an individual assessment — care needs vary so much that a flat number wouldn't be honest. I'd rather meet your mother first and give you something accurate than quote a range you can't rely on.\n\nThere's no waitlist currently.\n\nNights we're at one to twelve, with an RN on duty.\n\nSaturday is open for a tour if you'd like to come by.` +
            signature("Anthony Reyes", "Admissions Director", facilityName),
        ],
        variant,
      ),
    }),
    // The follow-up lands and the number appears. It always could have.
    second: ({ facilityName, variant }) => ({
      body: pick(
        [
          `You're right to push, and I'm sorry — I should have just given you the numbers.\n\nBase rate is $5,400/month for the room, meals and housekeeping. Care is banded on top of that: level one is $600, level two is $1,150, level three is $1,800. From what you've described about your mother she'd most likely land at level two, so realistically $6,550/month. There's also a $3,000 community fee on move-in, one time.\n\nSo the honest all-in answer is somewhere between $6,000 and $7,200 a month depending on where the assessment lands her.` +
            signature("Sharon Whitfield", "Director of Admissions", facilityName),
          `Fair enough — here are the actual figures.\n\nRoom and board is $5,200. Care tiers run $500 / $1,000 / $1,700 on top. Most residents at your mother's described level sit in the middle tier, so about $6,200 a month, and there is a one-time $2,500 fee when she moves in.\n\nRange to plan around: $5,700 to $6,900.` +
            signature("Anthony Reyes", "Admissions Director", facilityName),
        ],
        variant,
      ),
    }),
  },

  // -------------------------------------------------------------------------
  // Answers on money, goes vague on who is actually on the floor at 3am. This
  // is the one where the federal staffing record matters most: the facility's
  // own claim and CMS's published hours belong on the same line.
  // -------------------------------------------------------------------------
  dodges_staffing: {
    key: "dodges_staffing",
    label: "Dodged night staffing",
    dodgesFirstRound: ["staffing"],
    first: ({ facilityName, careLevelPhrase, variant }) => ({
      body: pick(
        [
          `Hi,\n\nWe do have one opening in ${careLevelPhrase} right now.\n\nThe all-in rate is $5,950 a month — that includes the care package, meals, laundry and activities. No community fee.\n\nNo waitlist for that room type at present.\n\nWe staff above the state minimum at all times and our team is wonderful — many of them have been here over ten years.\n\nTours are Saturday mornings, we'd be glad to see you.` +
            signature("Colleen Barrett", "Admissions", facilityName),
          `Hello,\n\nGood timing — a room opened up in ${careLevelPhrase} this week.\n\n$6,050/month all inclusive, no surcharges and no move-in fee.\n\nThere's no waitlist.\n\nWe always meet or exceed the required staffing levels and have never had an issue there.\n\nHappy to book you in for a tour Saturday.` +
            signature("Dev Patel", "Community Relations Director", facilityName),
        ],
        variant,
      ),
    }),
    second: ({ facilityName, variant }) => ({
      body: pick(
        [
          `Overnight it's one caregiver to eighteen residents, from 11pm to 7am. There's a licensed nurse on call but not always in the building on the night shift — she covers two of our houses.\n\nWeekends run the same as nights on the day shift, so one to eighteen.` +
            signature("Colleen Barrett", "Admissions", facilityName),
          `Nights we're at 1:20, weekends 1:16 during the day. I'll be straight with you, we've been short on the overnight shift since two people left in the spring and we're actively hiring.` +
            signature("Dev Patel", "Community Relations Director", facilityName),
        ],
        variant,
      ),
    }),
  },

  // -------------------------------------------------------------------------
  // The address is dead. This happens constantly and the board must show it
  // rather than quietly dropping the row — a facility we could not reach keeps
  // its place with its inspection record and its CMS phone number.
  // -------------------------------------------------------------------------
  bounces: {
    key: "bounces",
    label: "Address bounced",
    bounces: true,
    dodgesFirstRound: ["opening", "cost", "waitlist", "staffing", "tour"],
    first: () => ({ body: "" }),
  },

  // -------------------------------------------------------------------------
  // Delivered, read, ignored. Gets one polite nudge after 72 hours and then we
  // leave them alone (CLAUDE.md section 4: one nudge, never more).
  // -------------------------------------------------------------------------
  silent: {
    key: "silent",
    label: "No response",
    silent: true,
    dodgesFirstRound: ["opening", "cost", "waitlist", "staffing", "tour"],
    first: () => ({ body: "" }),
  },
};

/**
 * The roster a demo campaign is seeded from, in assignment order.
 *
 * Ordered so that a shortlist of any size still has range: the first four give
 * the four outcomes CLAUDE.md asks for, and the dodge — our best moment — lands
 * early enough to be on screen inside the first minute.
 *
 * `silent` sits at position six deliberately. Only the facilities Firecrawl
 * found an address for get a persona, and that is typically half a shortlist —
 * a twelve-home search seeds six conversations. With `silent` any further down
 * the list, a real run would never produce a facility that says nothing, and
 * the 72-hour nudge would be a code path nobody had ever watched work.
 */
export const PERSONA_ROSTER: PersonaKey[] = [
  "has_opening",
  "dodges_pricing",
  "waitlisted",
  "bounces",
  "dodges_staffing",
  "silent",
  "has_opening",
  "waitlisted",
  "dodges_pricing",
  "has_opening",
  "dodges_staffing",
  "waitlisted",
];

export function personaFor(index: number): Persona {
  return PERSONAS[PERSONA_ROSTER[index % PERSONA_ROSTER.length]];
}

/**
 * When a seeded persona answers, measured from the moment its letter goes out.
 *
 * This is the clock the cold open is built on, so it is deliberate rather than
 * random. CLAUDE.md section 7.2 gives us sixty seconds from a judge's click to
 * a board with live replies on it, and that budget has to cover the whole
 * mechanism, including the follow-up round — the moment where a facility dodges
 * the pricing question and the agent writes back in-thread on its own. A
 * uniform 20-90 second draw put the first reply anywhere in a seventy-second
 * window and could push the follow-up past two minutes, which loses the
 * strongest thing we have on camera.
 *
 * So the delay is a function of the facility's position in the roster: an
 * ascending ladder from about eight seconds, spread far enough apart that the
 * board visibly fills in one row at a time rather than blinking on at once.
 * Position 1 is `dodges_pricing`, which answers early precisely so its
 * follow-up round has room to complete inside the minute.
 *
 * The jitter is a second either way — enough that the board does not tick like
 * a metronome, small enough that the run is still rehearsable.
 *
 * This governs simulated facilities only. A real facility answers when it
 * answers, and nothing here touches that path.
 */
const REPLY_BASE_MS = 8_000;
const REPLY_STEP_MS = 4_500;
const REPLY_JITTER_MS = 1_000;

export function replyDelayMs(rosterIndex = 0): number {
  const override = Number(process.env.OMBUDS_REPLY_DELAY_MS);
  if (Number.isFinite(override) && override >= 0) return override;

  const ladder = REPLY_BASE_MS + rosterIndex * REPLY_STEP_MS;
  const jitter = Math.floor((Math.random() * 2 - 1) * REPLY_JITTER_MS);
  return Math.max(2_000, ladder + jitter);
}
