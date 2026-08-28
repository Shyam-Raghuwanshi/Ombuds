/**
 * Pure helpers for turning a federal facility record into an email address.
 *
 * CMS gives us a provider name, a city, a state, and a phone number. It has no
 * website column and no email column at all (CLAUDE.md section 6, fact 4), so
 * every decision in this file is about doing that join across the open web
 * without ever guessing. Nothing here invents an address: each function either
 * returns something it actually read off a page, or nothing.
 */

/**
 * Domains that must never be mistaken for a facility's own website.
 *
 * The first group is the reason this product exists. A Place for Mom and the
 * other referral networks rank at the top of exactly the search we are running,
 * they are paid $10,000-$15,000 per placement by the facilities they list, and
 * an email sent to one of them would be an email to a sales desk rather than to
 * the home. The rest are directories, review sites, and job boards that outrank
 * small facilities but do not speak for them.
 */
const NEVER_THE_FACILITY = [
  // Paid referral networks — the incumbent and its peers.
  "aplaceformom.com",
  "caring.com",
  "seniorly.com",
  "seniorhousingnet.com",
  "senioradvisor.com",
  "assistedliving.com",
  "sunriseseniorliving.com/find", // marketplace pages, not a single home
  "retirementhomes.com",
  "seniorcare.com",
  "carelisting.com",
  // Government and directory listings — useful, but not an inbox.
  "medicare.gov",
  "cms.gov",
  "usnews.com",
  "nursinghomes.com",
  "nursinghomeratings.org",
  "ltcombudsman.org",
  "hhs.gov",
  "ca.gov",
  "ny.gov",
  "state.tx.us",
  // Reviews, maps, social, jobs.
  "yelp.com",
  "google.com",
  "bing.com",
  "mapquest.com",
  "facebook.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "linkedin.com",
  "indeed.com",
  "glassdoor.com",
  "ziprecruiter.com",
  "wikipedia.org",
  "yellowpages.com",
  "bbb.org",
  "healthgrades.com",
  "zillow.com",
  "apartments.com",
  "tripadvisor.com",
  "youtube.com",
];

/**
 * The same list, flattened for Firecrawl's `excludeDomains`.
 *
 * Filtering server-side matters more than it looks: a search for a small
 * nursing home returns eight aggregator pages and nothing else, so unless the
 * directories are excluded *before* the results come back, the facility's own
 * site never appears in them at all.
 */
export const EXCLUDE_DOMAINS: string[] = NEVER_THE_FACILITY.map(
  (entry) => entry.split("/")[0],
);

export function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

export function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function isExcludedHost(host: string): boolean {
  return NEVER_THE_FACILITY.some(
    (bad) =>
      host === bad ||
      host.endsWith(`.${bad}`) ||
      // entries carrying a path fragment ("sunriseseniorliving.com/find")
      (bad.includes("/") && host === bad.split("/")[0]),
  );
}

/** Words that carry no identifying signal when matching a name to a domain. */
const STOPWORDS = new Set([
  "the", "of", "at", "and", "a", "an", "inc", "llc", "lp", "co", "corp",
  "center", "centre", "health", "healthcare", "care", "nursing", "home",
  "homes", "rehab", "rehabilitation", "convalescent", "hospital", "facility",
  "living", "senior", "seniors", "skilled", "post", "acute", "subacute",
  "district", "county", "community", "services", "service", "group",
]);

function nameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

/**
 * Score one search result as "this is the facility's own site".
 *
 * The signal we trust most is that the distinctive words in the facility's name
 * show up in the domain: "Moraga Post Acute" -> moragapostacute.com. Position in
 * the results is a weak tie-breaker only — the top hit for a nursing home search
 * is very often a referral network, which is precisely the thing we exclude.
 */
export function scoreCandidateSite(args: {
  url: string;
  title?: string;
  facilityName: string;
  city: string;
  position: number;
}): number {
  const host = hostnameOf(args.url);
  if (!host || isExcludedHost(host)) return -1;

  const tokens = nameTokens(args.facilityName);
  if (tokens.length === 0) return -1;

  const hostFlat = host.replace(/[^a-z0-9]/g, "");
  const titleFlat = (args.title ?? "").toLowerCase();

  let score = 0;
  let matched = 0;
  for (const token of tokens) {
    if (hostFlat.includes(token)) {
      matched++;
      score += 10;
    } else if (titleFlat.includes(token)) {
      score += 3;
    }
  }
  // A domain that matches nothing distinctive in the name is not this facility,
  // however high it ranks. Better to report `no_website_found` than to email a
  // stranger.
  if (matched === 0) return -1;

  if (nameTokens(args.city).some((t) => hostFlat.includes(t))) score += 2;
  score += Math.max(0, 5 - args.position);
  return score;
}

/**
 * Rank the URLs a site map returned by how likely they are to publish an
 * address a family could actually write to.
 */
const PATH_WEIGHTS: Array<[RegExp, number]> = [
  [/\/admissions?\b/, 12],
  [/\/contact[-_]?us\b/, 11],
  [/\/contact\b/, 10],
  [/\/inquir(y|ies)\b/, 8],
  [/\/schedule[-_]?a?[-_]?tour\b/, 7],
  [/\/tour\b/, 6],
  [/\/get[-_]?in[-_]?touch\b/, 6],
  [/\/about[-_]?us\b/, 4],
  [/\/about\b/, 4],
  [/\/staff\b/, 3],
  [/\/(our[-_]?)?team\b/, 3],
  [/\/leadership\b/, 3],
  [/\/locations?\b/, 2],
];

const PATH_PENALTIES: Array<[RegExp, number]> = [
  [/\/(blog|news|events|gallery|photos)\b/, -6],
  [/\/(careers?|jobs?|employment|apply)\b/, -8],
  [/\/(privacy|terms|legal|sitemap|accessibility)\b/, -10],
  [/\.(pdf|jpg|jpeg|png|gif|zip)$/i, -20],
  // WordPress publishes an attachment page per image, and they sit directly
  // under the page they illustrate: /contact-us/contact_banner outranks the
  // real /contact-us on a naive keyword match while containing no text at all.
  [/[-_](banner|image|img|logo|icon|thumb|photo|bg|background)(?:[-_]?\d+)?$/, -25],
  [/\/(attachment|wp-content|wp-json|feed|amp)\b/, -25],
];

export function rankContactPages(
  links: Array<{ url: string; title?: string }>,
  siteHost: string,
): string[] {
  const seen = new Set<string>();
  const scored: Array<{ url: string; score: number }> = [];

  for (const link of links) {
    const host = hostnameOf(link.url);
    // Stay on the facility's own domain. A chain's corporate site is a
    // different inbox and often a different company.
    if (!host || host !== siteHost) continue;
    let path: string;
    try {
      path = new URL(link.url).pathname.toLowerCase().replace(/\/+$/, "");
    } catch {
      continue;
    }
    const key = `${host}${path}`;
    if (seen.has(key)) continue;
    seen.add(key);

    let score = path === "" ? 5 : 0; // the homepage is a reasonable fallback
    for (const [re, w] of PATH_WEIGHTS) if (re.test(path)) score += w;
    for (const [re, w] of PATH_PENALTIES) if (re.test(path)) score += w;
    // Prefer the shallowest page that matches. /contact-us is the contact page;
    // anything nested beneath it is a sub-resource of one.
    score -= Math.max(0, path.split("/").filter(Boolean).length - 1) * 3;
    if (score > 0) scored.push({ url: link.url, score });
  }

  return scored.sort((a, b) => b.score - a.score).map((s) => s.url);
}

// ---------------------------------------------------------------------------
// Email validation
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}$/;

/** Addresses that exist on a page but are not a way to reach the facility. */
const JUNK_LOCAL_PARTS = [
  "noreply", "no-reply", "donotreply", "do-not-reply", "postmaster",
  "abuse", "webmaster", "hostmaster", "sentry", "example", "you", "your",
  "name", "email", "someone", "user", "test",
];

const JUNK_DOMAINS = [
  "example.com", "example.org", "domain.com", "yourdomain.com", "email.com",
  "sentry.io", "wixpress.com", "godaddy.com", "squarespace.com", "test.com",
  "company.com", "website.com", "sentry-next.wixpress.com",
];

/** Local parts that are exactly who we want to reach. */
const PREFERRED_LOCAL_PARTS = [
  "admissions", "admission", "info", "contact", "inquiries", "inquiry",
  "marketing", "administrator", "director", "frontdesk", "reception", "hello",
];

export function isPlausibleEmail(candidate: string): boolean {
  const email = candidate.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return false;
  const [local, domain] = email.split("@");
  if (JUNK_LOCAL_PARTS.includes(local)) return false;
  if (JUNK_DOMAINS.includes(domain)) return false;
  // Image filenames and tracking pixels routinely parse as addresses.
  if (/\.(png|jpg|jpeg|gif|svg|webp|css|js)$/.test(domain)) return false;
  if (domain.split(".").pop()!.length > 24) return false;
  return true;
}

/**
 * Choose one address out of everything a page offered.
 *
 * Preference order is: an address on the facility's own domain, then one whose
 * local part is an admissions or general inbox, then anything else plausible.
 * We would rather send to `info@` at the right domain than to a named
 * administrator at a marketing agency's domain.
 */
export function pickBestEmail(
  candidates: string[],
  siteHost: string | null,
): string | null {
  const cleaned = [
    ...new Set(
      candidates
        .map((c) => c.trim().toLowerCase().replace(/^mailto:/, "").split("?")[0])
        .filter(isPlausibleEmail),
    ),
  ];
  if (cleaned.length === 0) return null;

  const rootOf = (host: string) => host.split(".").slice(-2).join(".");
  const siteRoot = siteHost ? rootOf(siteHost) : null;

  const score = (email: string): number => {
    const [local, domain] = email.split("@");
    let s = 0;
    if (siteRoot && rootOf(domain) === siteRoot) s += 20;
    const idx = PREFERRED_LOCAL_PARTS.indexOf(local);
    if (idx >= 0) s += 12 - idx;
    else if (PREFERRED_LOCAL_PARTS.some((p) => local.startsWith(p))) s += 6;
    if (/^(gmail|yahoo|hotmail|outlook|aol)\./.test(domain)) s -= 4;
    return s;
  };

  return cleaned.sort((a, b) => score(b) - score(a))[0];
}

/**
 * Addresses written into a page's own text. This is a document format, not
 * model prose — parsing it is reading, not guessing — and it is by far the most
 * reliable of the three signals we use, because a `mailto:` link on a contact
 * page was put there by the facility for exactly this purpose.
 */
export function harvestEmails(args: {
  links?: string[];
  markdown?: string;
  html?: string;
}): string[] {
  const found: string[] = [];

  for (const link of args.links ?? []) {
    if (link.toLowerCase().startsWith("mailto:")) found.push(link.slice(7));
  }
  const bodies = [args.markdown, args.html].filter(Boolean) as string[];
  for (const body of bodies) {
    for (const m of body.matchAll(/mailto:([^"'\s>)\]]+)/gi)) found.push(m[1]);
    for (const m of body.matchAll(
      /\b[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    )) {
      found.push(m[0]);
    }
  }
  return found;
}

/**
 * The search that turns a federal record into a website.
 *
 * Two things about this query were arrived at by testing, and both are
 * counter-intuitive:
 *
 * The name is NOT quoted. A quoted phrase search returns the directory sites
 * that reproduce the name verbatim and buries the facility's own pages, which
 * often write the name slightly differently from CMS.
 *
 * It ends in "admissions contact" rather than "nursing home official website".
 * Asking for the official website returns aggregator pages, because that is the
 * language aggregator pages are written in. Asking for admissions and contact
 * returns the facility's own contact page, because only the facility has one —
 * and that page is the one we want to scrape anyway.
 */
export function siteSearchQuery(args: {
  name: string;
  city: string;
  state: string;
}): string {
  return `${args.name} ${args.city} ${args.state} senior care admissions contact`;
}
