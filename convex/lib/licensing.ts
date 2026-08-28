/**
 * State assisted-living licensing portals, and the parsers for what they publish.
 *
 * Why this exists: CMS certifies *nursing homes*. Assisted living, adult homes,
 * and enriched housing are licensed by the states and appear nowhere in the
 * federal data. For a family whose parent does not need skilled nursing, the
 * federal record — the entire left-hand side of our board — is simply silent.
 * A durable crawl of a state licensing portal is how the product covers that
 * gap honestly rather than pretending the gap is not there.
 */

export type PortalKey = "NY" | "CA";

export type StatePortal = {
  state: string;
  portalName: string;
  /** Where the crawl starts. */
  url: string;
  /** Regexes matched against the URL path, so the crawl stays in the section. */
  includePaths: string[];
  limit: number;
  /** Which parser reads a stored page. */
  extractor: "nyAcfDirectory" | "none";
  /** The licence category this portal covers — used when a page lists no type. */
  defaultCareTypes: string[];
  /** Shown in the UI so a family knows exactly whose register this is. */
  description: string;
};

export const STATE_PORTALS: Record<PortalKey, StatePortal> = {
  NY: {
    state: "NY",
    portalName: "NYS Health Profiles — Adult Care Facilities",
    url: "https://profiles.health.ny.gov/acf/index",
    // The printable directory under /directory/acfs is the page that carries
    // the register itself; the /acf/ pages around it are how the crawl reaches
    // it, and are honestly reported as carrying no facility rows.
    includePaths: ["^/acf(/.*)?$", "^/directory/acfs/?$"],
    limit: 20,
    extractor: "nyAcfDirectory",
    defaultCareTypes: ["Adult Care Facility"],
    description:
      "New York's register of adult homes, assisted living residences, and " +
      "enriched housing programs. None of these are Medicare-certified nursing " +
      "homes, so none of them appear in the federal inspection data.",
  },
  CA: {
    state: "CA",
    portalName: "California DSS — Community Care Licensing",
    url: "https://www.cdss.ca.gov/inforesources/community-care-licensing",
    includePaths: ["^/inforesources/community-care-licensing(/.*)?$"],
    limit: 20,
    // California publishes its register through a search application rather
    // than a printable page, so the crawl gives us the programme documentation
    // but no facility rows. Saying that is better than a parser that invents
    // them.
    extractor: "none",
    defaultCareTypes: ["Residential Care Facility for the Elderly"],
    description:
      "California's Community Care Licensing Division, which licenses " +
      "residential care facilities for the elderly — a category the federal " +
      "nursing home data does not cover.",
  },
};

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export type LicensedRow = {
  name: string;
  address: string;
  city: string;
  zip: string;
  phone: string;
};

/**
 * Tokens a US street address ends on. Used to find where the street stops and
 * the city begins in a run of text with no punctuation between them.
 *
 * The unusual-looking entries at the end are all real, and each one was added
 * because a New York facility failed to parse without it: addresses on
 * Broadway, on the Rockaway Promenade, at Jefferson Heights, at Clark Mdws.
 */
const STREET_SUFFIX = new Set([
  "st", "street", "rd", "road", "ave", "av", "avenue", "blvd", "boulevard",
  "dr", "drive", "ln", "lane", "way", "pl", "place", "ct", "court", "cir",
  "circle", "hwy", "highway", "pkwy", "parkway", "tpke", "turnpike", "ter",
  "terrace", "trl", "trail", "pike", "route", "rte", "rt", "plaza", "square",
  "sq", "extension", "ext", "loop", "path", "row", "walk", "run", "crossing",
  "expy", "expressway", "broadway", "promenade", "heights", "meadows", "mdws",
  "concourse", "esplanade", "commons", "landing", "oval", "bowery", "mews",
]);

/** "6060", "130-132", "45A", "4192-B" — a house number, as opposed to a word. */
const HOUSE_NUMBER = /^\d+[A-Za-z]?(?:-[A-Za-z0-9]+)?$/;

/**
 * Buildings whose street number is spelled out. "One Fox Run Lane" is a real
 * address and there are several of them in this register.
 */
const WRITTEN_NUMBERS = new Set([
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve",
]);

const PO_BOX = /\bP\.?\s?O\.?\s+Box\s+\d+[A-Za-z]?\b/i;

/**
 * Flatten a scraped page to a single line of text.
 *
 * Markdown link syntax and table pipes are stripped; `#` is NOT stripped
 * wholesale, because facility names legitimately contain it ("NY Foundation
 * EHP#7") and mangling a name is worse than leaving a stray heading marker.
 * Newlines are preserved — see `extractNyAcfDirectory` for why they matter.
 */
function flatten(markdown: string): string {
  return markdown
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // [text](url) -> text
    .replace(/[*_`|>]/g, " ")
    .replace(/^#{1,6}\s+/gm, " ")
    .replace(/\\/g, " ")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

const normalizeToken = (token: string) =>
  token.toLowerCase().replace(/[^a-z]/g, "");

const isStreetSuffix = (token: string) => STREET_SUFFIX.has(normalizeToken(token));

const isHouseNumber = (token: string) =>
  HOUSE_NUMBER.test(token) || WRITTEN_NUMBERS.has(normalizeToken(token));

/**
 * Split "Name Street City" into its three parts.
 *
 * The state prints these as one unpunctuated run, so the boundaries have to be
 * inferred. Two rules do the work:
 *
 *   name | street  the LAST house number that still has a street suffix after
 *                  it. Taking the last one means a number inside a facility's
 *                  own name is skipped in favour of the real house number, and
 *                  requiring a suffix after it stops "4573 State Route 40
 *                  Argyle" splitting at the route number.
 *   street | city  the last street-suffix word after that house number.
 *
 * When no suffix appears anywhere — "108-25 Horace Harding Forest Hills", an
 * address the state simply printed without one — the city falls back to the
 * final two words. When even that cannot be made to work the row is dropped and
 * counted, never guessed at: a half-parsed address in a care directory is worse
 * than one fewer row, and the count is reported rather than swallowed.
 */
function splitNameStreetCity(
  head: string,
): { name: string; address: string; city: string } | null {
  const box = PO_BOX.exec(head);
  if (box) {
    const name = head.slice(0, box.index).trim();
    const city = head.slice(box.index + box[0].length).trim();
    if (name && city) return { name, address: box[0].trim(), city };
  }

  const tokens = head.split(" ").filter(Boolean);
  if (tokens.length < 4) return null;

  let streetStart = -1;
  let suffixAt = -1;
  for (let i = 1; i < tokens.length - 2; i++) {
    if (!isHouseNumber(tokens[i])) continue;
    let lastSuffix = -1;
    for (let j = i + 1; j < tokens.length - 1; j++) {
      if (isStreetSuffix(tokens[j])) lastSuffix = j;
    }
    if (lastSuffix !== -1) {
      streetStart = i;
      suffixAt = lastSuffix;
    }
  }

  let cityStart: number;
  if (streetStart !== -1) {
    cityStart = suffixAt + 1;
    // "4573 State Route 40 Argyle" — a number right after the suffix belongs to
    // the street (it is a route number), not to the city.
    while (cityStart < tokens.length - 1 && /^\d/.test(tokens[cityStart])) {
      cityStart++;
    }
  } else {
    // No suffix anywhere. Fall back to the last house number and assume the
    // final two words are the city.
    for (let i = 1; i < tokens.length - 2; i++) {
      if (isHouseNumber(tokens[i])) streetStart = i;
    }
    if (streetStart === -1 || tokens.length - streetStart < 4) return null;
    cityStart = tokens.length - 2;
  }

  const name = tokens.slice(0, streetStart).join(" ").trim();
  const address = tokens.slice(streetStart, cityStart).join(" ").trim();
  const city = tokens.slice(cityStart).join(" ").trim();
  if (!name || !address || !city) return null;
  return { name, address, city };
}

export type ExtractionOutcome = {
  rows: LicensedRow[];
  /** Records we found but could not parse cleanly. Reported, never hidden. */
  dropped: number;
};

const MAX_NAME_LENGTH = 120;
/** "Orchard Park, NY 14127" */
const CITY_LINE = /^(?<city>.+?),\s*(?<st>[A-Z]{2})\s+(?<zip>\d{5})(?:-\d{4})?$/;

/**
 * The exact read. New York prints each record as four separate blocks — name,
 * street, "City, ST ZIP", phone — so in markdown each lands on its own line and
 * there is nothing left to infer. Taking the last three lines before the phone
 * number also steps neatly over the page heading and navigation that precede
 * the very first record.
 */
function parseStructuredRecord(chunk: string): Omit<LicensedRow, "phone"> | null {
  const lines = chunk
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (lines.length < 3) return null;

  const cityLine = lines[lines.length - 1];
  const address = lines[lines.length - 2];
  const name = lines[lines.length - 3];

  const match = CITY_LINE.exec(cityLine);
  if (!match?.groups) return null;
  if (!name || name.length > MAX_NAME_LENGTH) return null;
  // A street line always carries a number, whether a house number or a PO box.
  // Requiring one is what stops a stray caption being read as an address.
  if (!/\d/.test(address)) return null;

  return { name, address, city: match.groups.city.trim(), zip: match.groups.zip };
}

/**
 * The inferred read, used only when the page arrives with its line structure
 * flattened away and the exact read has nothing to work with.
 */
function parseFlattenedRecord(chunk: string): Omit<LicensedRow, "phone"> | null {
  const flat = chunk.replace(/\s+/g, " ").trim();
  const tail =
    /^(?<head>.+?)\s*,\s*(?<st>[A-Z]{2})\s+(?<zip>\d{5})(?:-\d{4})?$/.exec(flat);
  if (!tail?.groups) return null;

  const parts = splitNameStreetCity(tail.groups.head.trim());
  if (!parts || parts.name.length > MAX_NAME_LENGTH) return null;
  return { ...parts, zip: tail.groups.zip };
}

/**
 * Read New York's printable adult care directory.
 *
 * The page is a run of records, each one a facility name, a street, a
 * "City, ST ZIP" line, and a phone number. The phone number is a reliable
 * record terminator, so the text is cut on those and each chunk read backwards
 * from the ZIP — exactly where the page's own structure survives, by inference
 * where it does not, and dropped and counted where neither works. A
 * half-parsed address in a care directory is worse than one fewer row.
 *
 * This is deterministic parsing of a fixed government page format, not a model
 * reading prose, which is the right call on both cost and reliability: the
 * crawl already fetched the text, and paying an LLM to re-read 530 rows that
 * follow one pattern would be slower, dearer, and less accurate.
 */
export function extractNyAcfDirectory(markdown: string): ExtractionOutcome {
  const text = flatten(markdown);
  const phoneRe = /Tel:\s*\((\d{3})\)\s*(\d{3})-(\d{4})/g;

  const rows: LicensedRow[] = [];
  let dropped = 0;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = phoneRe.exec(text)) !== null) {
    const chunk = text.slice(cursor, match.index);
    cursor = phoneRe.lastIndex;

    const parsed =
      parseStructuredRecord(chunk) ?? parseFlattenedRecord(chunk);
    if (!parsed) {
      dropped++;
      continue;
    }
    rows.push({
      ...parsed,
      phone: `(${match[1]}) ${match[2]}-${match[3]}`,
    });
  }

  return { rows, dropped };
}

/** Dispatch to the right parser for the portal this page came from. */
export function extractLicensedRows(
  extractor: StatePortal["extractor"],
  markdown: string | undefined,
): ExtractionOutcome {
  if (!markdown) return { rows: [], dropped: 0 };
  switch (extractor) {
    case "nyAcfDirectory":
      return extractNyAcfDirectory(markdown);
    case "none":
      return { rows: [], dropped: 0 };
  }
}
