# Hackathon log

- **Project:** Ombuds
- **Event:** Convex All Gas Hackathon
- **What it does:** Ranks nearby senior care facilities by their federal inspection record in plain English, then emails each shortlisted facility to ask what is never published — current openings, true monthly cost, waitlist, night staffing, and tour availability.
- **Live app:** not deployed
- **Repo:** https://github.com/Shyam-Raghuwanshi/Ombuds
- **Frontend:** Convex static hosting
- **Convex deployment:** not deployed
- **Components:** @convex-dev/agent, @agentmail/convex, @firecrawl/firecrawl-convex, @convex-dev/static-hosting, @convex-dev/workpool
- **Convex features:** schema, tables, indexes, queries, mutations, internal queries, internal mutations, actions, HTTP actions, realtime queries, paginated queries, components
- **Auth:** Convex Auth
- **AI models:** gpt-5-mini, gpt-5 (shipping target); gemini-3.5-flash-lite, gemini-3.5-flash selectable during the build. Chosen by the LLM_PROVIDER env var in `convex/ai/provider.ts`
- **Started:** 2026-08-27T14:32:17Z
- **Last updated:** 2026-08-28T14:10:00Z

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
