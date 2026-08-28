/**
 * Golden fixtures. CLAUDE.md section 11.5.
 *
 * Ten real (tag, scope/severity) pairs taken from the actual federal record of
 * the three demo facilities, spanning the whole harm grid from a paperwork
 * finding to widespread immediate jeopardy.
 *
 * The point of this file is the Sep 15 provider switch. Translation tone and
 * shape are the things most likely to drift silently when the model behind
 * `provider.ts` changes, and drift is invisible in aggregate — it only shows up
 * as two facilities being described in two different voices on the same screen.
 *
 * Run `npm run fixtures` before and after the switch and diff the two files.
 */

export type Fixture = {
  tag: string;
  scopeSeverity: string;
  tagDescription: string;
  /** Where this pair actually occurs, so the fixture stays checkable. */
  seenAt: string;
};

export const TRANSLATION_FIXTURES: Fixture[] = [
  {
    tag: "F0842",
    scopeSeverity: "D",
    tagDescription:
      "Safeguard resident-identifiable information and/or maintain medical records on each resident that are in accordance with accepted professional standards.",
    seenAt: "Mount San Antonio Gardens (055016), Rio Hondo (056487)",
  },
  {
    tag: "F0689",
    scopeSeverity: "D",
    tagDescription:
      "Ensure that a nursing home area is free from accident hazards and provides adequate supervision to prevent accidents.",
    seenAt: "Mount San Antonio Gardens (055016), Rio Hondo (056487)",
  },
  {
    tag: "F0880",
    scopeSeverity: "E",
    tagDescription: "Provide and implement an infection prevention and control program.",
    seenAt: "all three demo facilities",
  },
  {
    tag: "F0812",
    scopeSeverity: "F",
    tagDescription:
      "Procure food from sources approved or considered satisfactory and store, prepare, distribute and serve food in accordance with professional standards.",
    seenAt: "Moraga Post Acute (055085)",
  },
  {
    tag: "F0725",
    scopeSeverity: "E",
    tagDescription:
      "Provide enough nursing staff every day to meet the needs of every resident; and have a licensed nurse in charge on each shift.",
    seenAt: "Rio Hondo (056487)",
  },
  {
    // The example in CLAUDE.md section 4.
    tag: "F0689",
    scopeSeverity: "G",
    tagDescription:
      "Ensure that a nursing home area is free from accident hazards and provides adequate supervision to prevent accidents.",
    seenAt: "Moraga Post Acute (055085), Rio Hondo (056487)",
  },
  {
    tag: "F0686",
    scopeSeverity: "G",
    tagDescription:
      "Provide appropriate pressure ulcer care and prevent new ulcers from developing.",
    seenAt: "Rio Hondo (056487)",
  },
  {
    tag: "F0600",
    scopeSeverity: "J",
    tagDescription:
      "Protect each resident from all types of abuse such as physical, mental, sexual abuse, physical punishment, and neglect by anybody.",
    seenAt: "Rio Hondo (056487), Sep 2023",
  },
  {
    tag: "F0740",
    scopeSeverity: "J",
    tagDescription:
      "Ensure each resident must receive and the facility must provide necessary behavioral health care and services.",
    seenAt: "Rio Hondo (056487), Mar 2024",
  },
  {
    tag: "F0607",
    scopeSeverity: "K",
    tagDescription:
      "Develop and implement policies and procedures to prevent abuse, neglect, and theft.",
    seenAt: "Rio Hondo (056487), Sep 2023",
  },
];
