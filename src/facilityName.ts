/**
 * CMS publishes `provider_name` in capitals: MOUNT SAN ANTONIO GARDENS,
 * RIO HONDO SUBACUTE & NURSING CENTER. Rendered verbatim, every facility on
 * every screen shouts, and a shouting name is measurably slower to read than a
 * typeset one — which is the wrong trade for an audience of 45-to-65-year-olds
 * reading bad news on a phone (CLAUDE.md section 8).
 *
 * This is a presentation rule and lives on the client. The stored value stays
 * exactly as the federal record published it, so nothing here can drift from
 * the source; only the rendering changes.
 */

/**
 * Lowercased inside a name, never at the start. Deliberately short: this list
 * exists to stop "Gardens Of The Valley", not to enforce a house style.
 */
const MINOR = new Set([
  "a", "an", "and", "as", "at", "by", "de", "for", "in", "of", "on", "or",
  "the", "to", "with",
]);

/**
 * Strings that are not words and must survive intact. Care levels and company
 * forms mostly — "SNF" title-cased to "Snf" reads as a typo, and the state
 * registers are full of them.
 */
const KEEP_UPPER = new Set([
  "LLC", "LLP", "LP", "INC", "LTD", "CO", "PC", "PLLC",
  "SNF", "ICF", "HFA", "ALP", "ALR", "CCRC", "VA", "DBA",
  "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X",
]);

/** "MOUNT SAN ANTONIO" yes; "Adirondack Manor HFA" no. */
function isShouting(name: string): boolean {
  const letters = name.replace(/[^A-Za-z]/g, "");
  if (letters.length === 0) return false;
  return letters === letters.toUpperCase();
}

/** Title-case one whitespace-delimited token, hyphens and slashes included. */
function caseToken(token: string, isFirst: boolean): string {
  const bare = token.replace(/[^A-Za-z.]/g, "");
  if (KEEP_UPPER.has(bare.toUpperCase().replace(/\./g, ""))) return token.toUpperCase();

  // Split on the separators that appear inside real names — ST. MARY'S,
  // WELL-SPRING, EAST/WEST — and case each part, so the separator survives.
  return token
    .toLowerCase()
    .replace(/([A-Za-z][A-Za-z']*)/g, (word, _w, offset: number) => {
      const atStart = isFirst && offset === 0;
      if (!atStart && MINOR.has(word)) return word;
      // O'BRIEN and MCDONALD are both common in this data and neither is
      // served by a plain capitalise; the letter after the prefix rises too.
      const cased = word.charAt(0).toUpperCase() + word.slice(1);
      return cased
        .replace(/^(O')([a-z])/, (_m, p, c: string) => p + c.toUpperCase())
        .replace(/^(Mc)([a-z])/, (_m, p, c: string) => p + c.toUpperCase());
    });
}

/**
 * Title-case a federal provider name, leaving anything already typeset alone.
 *
 * The mixed-case guard matters: state licensing registers publish names like
 * "Adirondack Manor HFA D.B.A Willow Park HFA" that are already correct, and
 * re-casing them would only introduce errors.
 */
export function facilityName(name: string): string {
  if (!name) return name;
  if (!isShouting(name)) return name;
  return name
    .split(/(\s+)/)
    .map((part, i) => (/\s/.test(part) ? part : caseToken(part, i === 0)))
    .join("");
}
