# Hackathon log

- **Project:** Ombuds
- **Event:** Convex All Gas Hackathon
- **What it does:** Ranks nearby senior care facilities by their federal inspection record in plain English, then emails each shortlisted facility to ask what is never published — current openings, true monthly cost, waitlist, night staffing, and tour availability.
- **Live app:** not deployed
- **Repo:** https://github.com/Shyam-Raghuwanshi/Ombuds
- **Frontend:** Convex static hosting
- **Convex deployment:** not deployed
- **Components:** @convex-dev/agent, @agentmail/convex, @firecrawl/firecrawl-convex, @convex-dev/static-hosting, @convex-dev/workpool
- **Convex features:** schema, tables, indexes, queries, mutations, internal queries, internal mutations, actions, internal actions, HTTP actions, scheduled functions, realtime queries, paginated queries, components
- **Auth:** Convex Auth
- **AI models:** gpt-5-mini, gpt-5 (shipping target); gemini-3.5-flash-lite, gemini-3.5-flash selectable during the build. Chosen by the LLM_PROVIDER env var in `convex/ai/provider.ts`
- **Started:** 2026-08-27T14:32:17Z
- **Last updated:** 2026-08-28T09:28:09Z

## Log

### 2026-08-27 - working tree
Project scoped, no application code yet. Wrote the permanent project brief
(`CLAUDE.md`) covering the product thesis, the CMS scope/severity harm grid, a
draft Convex schema, and a cost-control rule that caches deficiency translations
by tag and severity. Added a phased build plan (`BUILD_PROMPTS.md`).
Set up the build environment: installed the official Convex plugin for Claude
Code (skills, subagents, hooks, and the Convex MCP server) at the user scope,
plus the hackathon build-log skill in `.claude/skills/convex-hackathon-skill/`.
Chose Convex static hosting as the frontend target. No Convex project files
exist yet, so there are no Convex features to report.
The Git repository is initialized but has no commits, so these dates come from
file modification times rather than commit history.

### 2026-08-28 - 3960740
First commit: the full scaffold. A judge opening the app is signed in silently —
anonymous sign-in fires on mount, so there is no login form (`convex/auth.ts`,
`src/App.tsx`). The rest of the UI is a placeholder that only reports backend
and session state.
Backend is schema-complete ahead of the data: facilities, deficiencies,
tagTranslations, penalties, facilityNews, searches, inquiries, and
simulatedFacilities, with indexes on CCN, ZIP, state/city, rating, and
search/thread/status (`convex/schema.ts`). Translations live in their own table
keyed by tag and severity rather than on each citation row, so ~300k citations
share ~1.5k cached meanings.
Registered five components in `convex/convex.config.ts` — agent, AgentMail,
Firecrawl, static hosting, and two named workpools (`inquiryPool`,
`enrichmentPool`) so an email fan-out and a crawl cannot queue behind each
other. `convex/http.ts` keeps the root router: auth routes first, then the
AgentMail webhook and a Firecrawl health probe, with the static-hosting
catch-all registered last so it cannot shadow them.
Not yet built: no queries, mutations, or actions exist, no CMS data is ingested,
and the AgentMail webhook is a stub that returns 501 until the inbound handler
is wired.

### 2026-08-28 - f5db9f7
Federal inspection citations now read as English instead of tag codes. A family
opening a facility gets sentences like "A resident fell because a known hazard
was not fixed. This caused actual harm." in place of "F0689, scope/severity G",
plus a two-to-three sentence summary of the pattern across the facility's whole
history — the thing that separates one corrected incident from the same failure
every year.
Translations are cached by (tag, severity) in their own table and by nothing
else, because F0689 at severity G means the same thing in every state. Loading
all three demo facilities produced 238 citations but only 109 distinct meanings,
24 of which were already shared between facilities. Nothing citation-specific
enters the cached text: the correction date is appended deterministically at
read time so the cache stays reusable. Nothing is translated during ingest —
translation fires on view, once per facility, and the reactive query streams
each sentence into the open page as it lands (`convex/deficiencies.ts`,
`src/useLazyTranslate.ts`).
Every model call in the codebase goes through one file that picks the provider
from an env var and validates both providers against the same zod schema, so
the planned switch is a config change rather than an edit (`convex/ai/provider.ts`,
`convex/ai/schemas.ts`). Ten real citations spanning the whole harm grid are
pinned as golden fixtures with a runner that writes a diffable file, so tone
drift at the switch is visible in minutes (`convex/ai/fixtures.ts`,
`scripts/run-fixtures.mjs`).
Real CMS data is loading: the citation code look-up (643 rows) and three
California facilities chosen for genuinely different records — 14 findings and
no harm, one isolated actual-harm fall, and 196 findings with five immediate
jeopardies. Ingest joins the look-up table because the citation rows truncate
their own descriptions mid-word, filters server-side by CCN so it never touches
the 157 MB bulk file, and calls no model at all (`convex/cms.ts`).
Frontend shows the three side by side and a full detail page. Immediate jeopardy
gets a red banner, and red appears nowhere else in the product (`src/Compare.tsx`,
`src/FacilityDetail.tsx`, `src/severity.ts`).
Blocked: the dev provider's API credits are exhausted and no OpenAI key is set
on the deployment, so the translation and summary paths are deployed and
verified up to the model call but have not yet produced real output.

### 2026-08-28 - 1fab767
The federal record publishes a phone number for every one of the 14,690
certified facilities and no website or email at all, so there is no path from a
provider number to an inbox. Firecrawl now builds that path: search finds the
facility's own site, map finds its contact page, and scrape reads the address
off it along with care levels, room types, amenities, and any published price
(`convex/enrichment.ts`, `convex/lib/contact.ts`). Verified live against the
three demo facilities — two resolved to a real published address, the third
resolved to its website but has no address on it. Two search behaviours had to
be found by testing: an unquoted query returns the facility's own site where a
quoted one returns only directories, and the referral networks have to be
excluded server-side or they fill all eight result slots.
Facilities we cannot reach stay on the board. `no_website_found` and
`no_email_found` are ordinary outcomes with their own sentences and the CMS
phone number, not errors, and the board counts them out loud — dropping them
would be the same filtering the product exists to argue against
(`src/ContactPanel.tsx`, `src/Compare.tsx`). Every Firecrawl failure maps to a
message written for a worried reader, including 402 out of credits and 429 rate
limited, and each one says that the federal inspection record is unaffected
(`convex/lib/firecrawlErrors.ts`). A rate limit reschedules itself once through
`ctx.scheduler`; discovery across a shortlist fans out through the bounded
`enrichmentPool` workpool.
Local news search is wired on the same lazy trigger. CMS is months behind by the
time it publishes; the county paper is not. Results are triaged by the model for
whether they are about this exact facility before anything is stored, because
chains share one brand across dozens of buildings and attributing another home's
lawsuit here would be a real harm. Nothing in that section is red — red in this
product means a federal inspector found a resident was hurt — and every item
carries its outlet, its link, and a line saying it is reporting rather than a
finding (`convex/news.ts`, `src/NewsPanel.tsx`).
A durable Firecrawl crawl now covers what CMS does not: assisted living, adult
homes, and enriched housing are licensed by the states and appear nowhere in the
federal data. A crawl of New York's Health Profiles adult care register read 20
pages and extracted 521 licensed facilities, none of which have a federal
inspection record. Progress is a plain `useQuery` over the component's crawl row
— pages read, pages stored, facilities found, and credits used all move on their
own, no polling (`convex/licensing.ts`, `src/LicensingCrawl.tsx`). The completion
callback is an internal mutation that schedules extraction; poll mode is used
until a webhook secret is set. Register pages are parsed deterministically rather
than by a model: the state prints a fixed four-block record per facility, so
reading it exactly is cheaper and more accurate than paying to re-read 530 rows
that follow one pattern, and rows that cannot be parsed cleanly are counted and
reported rather than guessed (`convex/lib/licensing.ts`). 19 of the 20 crawled
pages were navigation and the UI says so.
Blocked: the dev provider's API credits are still exhausted and no OpenAI key is
set on the deployment. The Firecrawl half of the news scan is verified live — a
search returned 19 candidates — but the triage step that decides which of them
are real cannot run, so it degrades to a message and stores nothing rather than
publishing untriaged results.
