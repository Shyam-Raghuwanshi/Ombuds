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
    website: v.optional(v.string()),
    contactEmail: v.optional(v.string()), // <- discovered by Firecrawl
    enrichment: v.optional(
      v.object({
        careLevels: v.array(v.string()),
        roomTypes: v.array(v.string()),
        amenities: v.array(v.string()),
        publishedPricing: v.optional(v.string()),
      }),
    ),
    enrichedAt: v.optional(v.number()),
    lastCmsSync: v.number(),
  })
    .index("by_ccn", ["ccn"])
    .index("by_zip", ["zip"])
    .index("by_state_city", ["state", "city"])
    .index("by_rating", ["overallRating"]),

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

  // Firecrawl search — CMS is months behind, the local paper is not.
  facilityNews: defineTable({
    ccn: v.string(),
    title: v.string(),
    url: v.string(),
    snippet: v.string(),
    publishedAt: v.number(),
    concernLevel: v.string(),
    foundAt: v.number(),
  }).index("by_ccn", ["ccn"]),

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
