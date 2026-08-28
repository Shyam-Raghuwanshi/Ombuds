import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

/**
 * Federal source: CMS Provider Data Catalog, topic "Nursing homes including
 * rehab services". Updated monthly, ~14,600 certified facilities.
 *
 * Scope/severity letters A-L encode harm and spread:
 *   A,B,C -> minimal   D,E,F -> potential
 *   G,H,I -> actual_harm      J,K,L -> immediate_jeopardy
 * G and above is the number families actually need.
 */
const harmLevel = v.union(
  v.literal("minimal"),
  v.literal("potential"),
  v.literal("actual_harm"),
  v.literal("immediate_jeopardy"),
);

const spread = v.union(
  v.literal("isolated"),
  v.literal("pattern"),
  v.literal("widespread"),
);

/**
 * Where a Firecrawl contact-discovery run ended up. `no_website_found` and
 * `no_email_found` are ordinary outcomes, not errors: many nursing homes have
 * no site, a broken one, or no published address.
 */
const contactStatus = v.union(
  v.literal("pending"),
  v.literal("discovered"),
  v.literal("no_website_found"),
  v.literal("no_email_found"),
  v.literal("failed"),
);

/**
 * How worrying a piece of local press is. Assigned by the model, never by us,
 * and always shown next to the outlet and the link so the reader can judge for
 * themselves.
 */
const concernLevel = v.union(
  v.literal("informational"),
  v.literal("concerning"),
  v.literal("serious"),
);

export default defineSchema({
  ...authTables,

  facilities: defineTable({
    ccn: v.string(), // CMS federal provider number — unique key
    name: v.string(),
    address: v.string(),
    city: v.string(),
    state: v.string(),
    zip: v.string(),
    county: v.string(),
    phone: v.string(),
    ownershipType: v.string(), // for-profit / non-profit / government
    certifiedBeds: v.number(),
    overallRating: v.number(),
    healthInspectionRating: v.number(),
    staffingRating: v.number(),
    qmRating: v.number(),
    abuseIcon: v.boolean(), // CMS flags facilities with abuse citations
    latitude: v.number(),
    longitude: v.number(),
    // CMS publishes a phone number and nothing else — no website, no email.
    // Everything below this line was found on the open web by Firecrawl.
    website: v.optional(v.string()),
    contactEmail: v.optional(v.string()),
    // The honest outcome of a discovery run. A facility we could not reach
    // keeps its place on the board with its safety record and its CMS phone
    // number: hiding it would reproduce exactly the filtering that A Place for
    // Mom does. 30-50% of runs end at `no_website_found` or `no_email_found`
    // and that is the expected, documented result (CLAUDE.md section 4).
    contactStatus: v.optional(contactStatus),
    // Provenance: the exact page the address was read off, so a family can go
    // and look at it themselves.
    contactSourceUrl: v.optional(v.string()),
    // Why a run failed, in words we are willing to show a user. Never swallowed.
    enrichmentError: v.optional(v.string()),
    enrichment: v.optional(
      v.object({
        careLevels: v.array(v.string()),
        roomTypes: v.array(v.string()),
        amenities: v.array(v.string()),
        publishedPricing: v.optional(v.string()),
      }),
    ),
    enrichedAt: v.optional(v.number()),
    newsScannedAt: v.optional(v.number()),
    lastCmsSync: v.number(),
  })
    .index("by_ccn", ["ccn"])
    .index("by_zip", ["zip"])
    .index("by_state_city", ["state", "city"])
    .index("by_rating", ["overallRating"])
    .index("by_contact_status", ["contactStatus"]),

  deficiencies: defineTable({
    ccn: v.string(),
    surveyDate: v.number(),
    tag: v.string(), // e.g. "F689"
    tagDescription: v.string(),
    scopeSeverity: v.string(), // "A".."L"
    harmLevel,
    spread,
    isComplaint: v.boolean(),
    correctionDate: v.optional(v.number()),
    // NO plainEnglish here. Translation lives in tagTranslations, joined at
    // read time. 300,000 rows share ~1,500 meanings. See CLAUDE.md section 10.
  })
    .index("by_ccn", ["ccn"])
    .index("by_ccn_harm", ["ccn", "harmLevel"]),

  // The ONLY place OpenAI-translated text lives. Cached by (tag, scopeSeverity)
  // — this is the difference between ~$1 and ~$510.
  tagTranslations: defineTable({
    tag: v.string(), // "F689"
    scopeSeverity: v.string(), // "G"
    plainEnglish: v.string(),
    model: v.string(), // which model produced it — provenance
    createdAt: v.number(),
  }).index("by_tag_severity", ["tag", "scopeSeverity"]),

  // Full, untruncated citation text. The `deficiency_description` on a citation
  // row is truncated mid-sentence ("...prevent acc"), so ingest joins to the CMS
  // Citation Code Look-up (dataset tagd-9999, 643 rows) for the real wording.
  // Cheap, static, and shared by every facility — no LLM involved.
  tagCatalog: defineTable({
    tag: v.string(), // "F0689"
    prefix: v.string(), // "F"
    number: v.string(), // "0689"
    description: v.string(), // full CMS text
    category: v.string(), // "Quality of Life and Care Deficiencies"
  }).index("by_tag", ["tag"]),

  // Per-facility risk summary. Unlike tagTranslations this cannot be shared
  // between facilities — it describes one facility's pattern over time — so it
  // is cached per CCN and regenerated only when the citation history changes.
  // Generated LAZILY on facility view, never during ingest (CLAUDE.md s10).
  facilityRiskSummaries: defineTable({
    ccn: v.string(),
    summary: v.string(), // 2-3 sentences about the pattern, not a list
    pattern: v.union(
      v.literal("clean"),
      v.literal("isolated_incident"),
      v.literal("improving"),
      v.literal("recurring"),
      v.literal("severe_recurring"),
    ),
    citationCount: v.number(), // basis: how many citations it was written from
    latestSurveyDate: v.number(), // basis: newest survey it saw
    model: v.string(), // provenance — which model wrote it
    createdAt: v.number(),
  }).index("by_ccn", ["ccn"]),

  penalties: defineTable({
    ccn: v.string(),
    date: v.number(),
    type: v.string(),
    fineAmount: v.number(),
  }).index("by_ccn", ["ccn"]),

  // Firecrawl search over recent local press.
  //
  // This table exists because of a timing gap, not a data gap. A state survey
  // is written up, disputed, and finally published to CMS months after the
  // inspector walked out; the county paper runs the lawsuit the week it is
  // filed. Everything here is dated and attributed to its outlet, and it is
  // never mixed in with the federal record on screen.
  facilityNews: defineTable({
    ccn: v.string(),
    title: v.string(),
    url: v.string(),
    outlet: v.string(), // hostname — the reader should see who published it
    snippet: v.string(),
    publishedAt: v.number(), // 0 when the outlet published no date
    concernLevel, // assigned by the model
    // One sentence on why this matters, written by the model from the snippet.
    whyItMatters: v.string(),
    model: v.string(), // provenance — which model judged it
    foundAt: v.number(),
  })
    .index("by_ccn", ["ccn"])
    // Dedupe key: the same story resurfaces on every rescan.
    .index("by_ccn_url", ["ccn", "url"]),

  // =========================================================================
  // State assisted-living licensing — coverage the federal record does not have
  // =========================================================================
  //
  // CMS certifies nursing homes. Assisted living, adult homes, and enriched
  // housing are licensed by the STATES and appear nowhere in the federal data,
  // so for a family whose parent does not need skilled nursing the CMS record
  // is silent. A durable Firecrawl crawl of a state licensing portal is how we
  // extend past that edge (CLAUDE.md section 4).

  // One durable crawl of one state's portal. The component owns the crawl's
  // own progress row; this is our app-side record of why we started it and
  // what we got out of it.
  licensingCrawls: defineTable({
    state: v.string(), // "NY"
    portalName: v.string(), // "NYS Health Profiles — Adult Care Facilities"
    url: v.string(),
    crawlId: v.string(), // Firecrawl component crawl id — subscribe to this
    jobId: v.optional(v.string()),
    mode: v.union(v.literal("webhook"), v.literal("poll")),
    status: v.union(
      v.literal("scraping"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("cancelled"),
    ),
    pagesStored: v.number(),
    facilitiesExtracted: v.number(),
    pagesWithNoRows: v.number(), // honest: most portal pages are navigation
    error: v.optional(v.string()),
    startedAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_state", ["state"])
    .index("by_crawl", ["crawlId"]),

  // A state-licensed facility that has no CMS certification number, because
  // the federal government does not regulate it.
  licensedFacilities: defineTable({
    state: v.string(),
    name: v.string(),
    address: v.string(),
    city: v.string(),
    zip: v.string(),
    phone: v.string(),
    careTypes: v.array(v.string()), // "Adult Home", "Assisted Living Residence"
    sourceUrl: v.string(), // provenance — the state page this was read from
    crawlId: v.string(),
    foundAt: v.number(),
  })
    .index("by_state", ["state"])
    .index("by_crawl", ["crawlId"])
    .index("by_state_city", ["state", "city"]),

  // One family's search.
  searches: defineTable({
    userId: v.id("users"),
    label: v.string(),
    zip: v.string(),
    radiusMiles: v.number(),
    careLevel: v.union(
      v.literal("independent"),
      v.literal("assisted"),
      v.literal("memory"),
      v.literal("skilled"),
    ),
    budgetMax: v.optional(v.number()),
    mustHaves: v.array(v.string()),
    inboxId: v.string(), // <- dedicated AgentMail inbox for this search
    isSample: v.boolean(), // true for the judge cold-open run
    createdAt: v.number(),
  }).index("by_user", ["userId"]),

  // One facility x one search = one email thread.
  inquiries: defineTable({
    searchId: v.id("searches"),
    ccn: v.string(),
    facilityName: v.string(),
    toEmail: v.string(),
    threadId: v.optional(v.string()), // AgentMail thread
    outboundId: v.optional(v.string()),
    status: v.union(
      v.literal("queued"),
      v.literal("sent"),
      v.literal("delivered"),
      v.literal("replied"),
      v.literal("clarifying"),
      v.literal("answered"),
      v.literal("bounced"),
      v.literal("no_response"),
    ),
    sentAt: v.optional(v.number()),
    lastNudgeAt: v.optional(v.number()),
    nudgeCount: v.number(),
    rounds: v.number(), // how many back-and-forths — surface this in the UI
    // parsed answers
    hasOpening: v.optional(v.boolean()),
    monthlyCostLow: v.optional(v.number()),
    monthlyCostHigh: v.optional(v.number()),
    waitlistWeeks: v.optional(v.number()),
    tourOffered: v.optional(v.boolean()),
    staffRatioNights: v.optional(v.string()),
    confidence: v.optional(v.number()), // 0-1 from the parser
    unanswered: v.array(v.string()), // which of our 5 questions they dodged
    replySummary: v.optional(v.string()),
  })
    .index("by_search", ["searchId"])
    .index("by_thread", ["threadId"])
    .index("by_search_status", ["searchId", "status"]),

  // Demo only — we never email real facilities. See CLAUDE.md section 7.1.
  simulatedFacilities: defineTable({
    ccn: v.string(),
    inboxId: v.string(),
    persona: v.string(),
    responseDelayMs: v.number(),
  }),
});
