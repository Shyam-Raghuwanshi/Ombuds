# Hackathon log

- **Project:** Ombuds
- **Event:** Convex All Gas Hackathon
- **What it does:** Ranks nearby senior care facilities by their federal inspection record in plain English, then emails each shortlisted facility to ask what is never published — current openings, true monthly cost, waitlist, night staffing, and tour availability.
- **Live app:** https://flexible-reindeer-206.convex.site
- **Repo:** https://github.com/Shyam-Raghuwanshi/Ombuds
- **Frontend:** Convex static hosting
- **Convex deployment:** https://flexible-reindeer-206.convex.cloud
- **Components:** @convex-dev/agent, @agentmail/convex, @firecrawl/firecrawl-convex, @convex-dev/static-hosting, @convex-dev/workpool
- **Convex features:** schema, tables, indexes, queries, mutations, internal queries, internal mutations, actions, internal actions, HTTP actions, crons, scheduled functions, pagination, realtime queries, paginated queries, components
- **Auth:** Convex Auth
- **AI models:** gpt-5-mini, gpt-5 (shipping target); gemini-3.5-flash-lite, gemini-3.5-flash selectable during the build. Chosen by the LLM_PROVIDER env var in `convex/ai/provider.ts`
- **Started:** 2026-08-27T14:32:17Z
- **Last updated:** 2026-09-05T20:31:29Z

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

### 2026-08-28 - c72a645
The email half of the product works end to end. A family's search provisions an
AgentMail inbox, drafts one letter, and writes to every shortlisted facility;
replies come back over the next minute and the board fills in underneath them.
Verified live on a twelve-facility shortlist near Pomona: six real AgentMail
sends went out labelled by search and CCN, six facilities had no published
address and stayed on the board with their inspection record and phone number,
and every row moved queued to sent to replied on its own
(`convex/email.ts`, `convex/searches.ts`, `src/Board.tsx`).

Every inquiry asks the same five things — opening, all-in monthly cost,
waitlist, night and weekend staffing ratio, tour dates. The model writes them in
the family's voice from their care level, budget, and must-haves, but it does
not get to decide which questions are asked: a dropped question is filled from
canonical phrasing before the letter goes out, so a blank on the board always
means a facility dodged something rather than that we forgot to ask
(`convex/lib/questions.ts`, `convex/lib/letter.ts`). The letter is drafted once
per family rather than once per facility, since only the name differs between
the twelve copies.

When a facility answers four questions and leaves one out, the agent writes back
in the same thread asking only for what is missing, then stops. Verified on the
seeded "depends on her care level" reply: round one gave an opening and no
price, the follow-up asked for the base rate and the care tiers, and round two
came back with $6,000 to $7,200 a month. One follow-up, then it stops. A cron
sends one nudge after 72 hours of silence and never a second
(`convex/crons.ts`).

No real nursing home is emailed. Two independent env flags, both off by default,
have to be set before a facility's own address can even be returned by the send
path, and in demo mode every inquiry is routed to an inbox we control and
answered by a seeded persona after 20 to 90 seconds — one with an opening, one
waitlisted six months, one that dodges the price, one that dodges night
staffing, and one dead address that bounces (`convex/lib/sendGuard.ts`,
`convex/lib/personas.ts`). Simulated threads are labelled on screen next to the
address we would have written to. The personas are hand-written rather than
model-generated so the parser is tested against text it did not write, and every
seeded reply is handed to the same `ingestInbound` function AgentMail's webhook
calls — there is one inbound code path, not a demo one and a real one.

Delivery state is the component's own: `onEvent` moves a row from sent to
delivered to bounced with no polling, and the webhook is mounted for real in
`convex/http.ts` where a 501 stub used to be. Search reads are owner-checked —
a search is one family's private list of where they are looking and what they
can afford.

Two blockers found by testing, one fixed. `@agentmail/convex@0.1.0` ships
`defineComponent("agentmail")` with no env contract while its request path reads
`AGENTMAIL_API_KEY` from the component's own `process.env`; Convex isolates
component env, so the key was set on the deployment and invisible inside the
component, and every send failed in the component's workpool. A committed patch
declares the two variables the component already reads, after which sends return
a real message id and thread id (`patches/@agentmail+convex+0.1.0.patch`). Still
open: the same version routes `createInbox`, `listInboxes`, `getThread`, and
`getMessage` through functions the component declares internal, which a mounting
app cannot resolve, so per-search inbox provisioning falls back to the shared org
inbox and records `inboxMode: "shared"` rather than pretending. The deployment's
API credential is separately denied `inbox_create`.

Blocked, unchanged from the previous entry: the dev provider's API credits are
exhausted and no OpenAI key is set, so the two model-dependent steps — drafting
the personalised letter and parsing a reply into structured fields — fall back to
canonical text and leave the availability column empty. Both were verified by
driving the parse chain directly with realistic parse results: the row settled
to answered with cost, waitlist, and night ratio, and the dodged-price row went
to clarifying and fired its follow-up.

### 2026-08-29 - d9b5c6a
Corrects the previous entry: the model-dependent steps are no longer blocked.
Letters are drafted and replies are parsed for real, on a working key.

A facility that answers four questions out of five now gets asked the fifth,
by the agent, in the same email thread, on its own. Verified end to end against
real CMS records and seeded AgentMail personas: a home that replied "it really
depends on her care level" was written back to and answered $6,000-$7,200 a
month plus a $3,000 move-in fee, and the rounds counter on its board row moved
from 1 to 2 while the page was open.

The loop runs inside Convex through `@convex-dev/agent`, which was registered
since the first commit and is now actually used (`convex/agentLoop.ts`). One
agent thread per conversation, so round two is reasoned about with round one in
front of it, and five tools: `lookupFacility`, `parseReply`, `sendFollowUp`,
`sendInquiry`, `rankResults`. The model decides whether to write back; it does
not decide whether it is allowed to. The two-round cap, an idempotency check on
"has a letter already gone out for this round", and the existing send guard all
refuse the agent exactly as they refuse anything else. A reconciliation runs
behind every turn and checks the outcome rather than the intention: if a reply
went unread or a follow-up went unsent, it does the work itself. Convex
features: internal actions, scheduled functions, agent component.

Four crons, each tied to something that changes on a clock nobody is watching
(`convex/crons.ts`). One polite nudge after 72 hours of silence and never a
second one — the check and the increment are a single mutation, so two sweeps
cannot both win; nudged-and-still-silent settles at `no_response`, which is an
answer a family can act on. The monthly CMS re-ingest diffs the new record
against the old one and raises an alert on every active search watching a
facility that picked up a harm-level citation since it was shortlisted
(`convex/cms.ts`). Answers older than thirty days are marked stale, because
"one room open now" was true in March and is worth nothing in July.

Every model call now lands in one ledger with its tokens priced, shown in a
small footer under the board (`convex/usage.ts`, `convex/ai/provider.ts`). A
model we have no published rate for records its tokens and no dollars rather
than a confident wrong number. Ingest also picks up the CMS staffing, turnover,
fines, and special-focus columns, so a facility's own claim about who is on the
floor at 3am can sit beside the registered-nurse hours the federal record
publishes for that building.

Four bugs found by running it rather than by reading it. A tool declared with an
empty parameter object is one this model will not call: it burned its steps and
answered in prose, and a whole rehearsal ended with four replies received and
none of them read — which is also why the reconciliation now covers an unread
reply and not just an unsent follow-up. Tools that act on one conversation are
built per turn with the ids closed over, after the model transposed a character
in a Convex id and a follow-up silently never went out. A second round was
overwriting the first round's answers in the unanswered list, so a facility that
had answered everything appeared to have answered almost nothing. And a fallback
letter written during a provider outage was being cached as if it were a result,
which would have kept sending the unpersonalised letter long after the provider
recovered.

The dev API credential is on a free tier that caps the larger model at 20
requests a minute, which a six-facility campaign exceeds, so both tiers point at
the small model during rehearsal via the existing `GEMINI_MODEL_LARGE` override.
The shipping target in `convex/ai/provider.ts` is unchanged.


### 2026-08-29 - 7792f41
Design pass over the whole frontend. Every colour became a semantic token in one
file, and dark mode a token swap through `@theme inline` rather than a `dark:`
variant per element — the ~144 of those across `src/` fell to 2, so light and
dark parity is structural instead of something to remember on one element out of
two hundred (`src/index.css`). Red is four tokens named for harm and never for
decoration; errors are deliberately not red, because an error is not a harm
finding.

Two measured WCAG failures fixed. Interactive control borders sat at 1.38:1
where a UI component needs 3:1. The focus ring was `outline-current`, which
computes to 1.02:1 against the immediate-jeopardy banner and simply disappears;
it is now a 3px ring with a white override on filled harm surfaces. Also: mobile
overflow from an unbreakable "$10,000-$15,000" and an offscreen skip link,
per-row Safety and Availability headings for the phone layout where the columns
stack, and an empty grey footer on rows with no discovered address that now says
what actually happened.

Empty, loading and error states are named components alongside the provenance
labels and an error boundary, so having all three on a screen is checkable
rather than a matter of memory (`src/ui.tsx`, wrapped per screen and at the root
in `src/App.tsx`). The boundary was verified against a real render throw rather
than assumed.

The cold open used to await inbox provisioning, an LLM letter draft and the
whole fan-out before returning anything, so a judge watched a disabled button
through a model call. The rows are now written first with no model involved, and
the letter is drafted while the family is already reading real inspection
records (`convex/searches.ts`). Reply delays became a deterministic ladder from
about eight seconds keyed to roster position, with the pricing-dodger early so
its follow-up round finishes inside the budget (`convex/lib/personas.ts`) — this
replaces the randomised 20-90 second delay the project brief describes, which
cannot fit a 60 second budget that also has to show a second round. Measured
with a stopwatch, twice: board 1.4s, twelve real facility rows 1.6s, first live
reply 15.0s, multi-round follow-up 21.9s.

The reordering introduced a failure mode where a draft error stranded all twelve
rows at "Queued to send" with nothing to explain it, so the draft is bounded to
12s against the existing canonical letter and dispatch no longer depends on the
draft succeeding.

### 2026-08-30 - e853342
Live at https://flexible-reindeer-206.convex.site. A judge opens the URL, is
signed in anonymously without a form, and clicks one button; the board fills
with twelve real Pomona-area facilities and their federal inspection records in
about seven seconds, the first facility reply lands at thirteen, the agent sends
its own in-thread clarifying follow-up by twenty-four, and the run settles at
thirty-six seconds with four replies, two openings, and one bounce. Verified
against production through the same actions the button calls, from a fresh
anonymous session with no cookies.

The whole federal catalog is now in production: 14,690 facilities, which is
every Medicare-certified nursing home in the country, plus the 643-row citation
look-up that supplies the untruncated tag text. Ingest is paged a thousand rows
at a time and chained through the scheduler, and writes in chunks below the
transaction limit, so fifteen CMS round trips and fifteen thousand upserts never
sit in one action (`cms:ingestAllFacilities`, `cms:upsertFacilityBatch`). It
touches no model and costs nothing. The single-facility pull and the full
catalog now share one row-to-document mapper, so there is exactly one place a
CMS column name is spelled. Health Deficiencies stays lazy and per-facility, as
it has to at 419,479 rows — the twelve facilities on the sample board carry
their real citation histories, from 14 for the five-star to 201 for the one-star.

Both webhooks are registered and reachable. Firecrawl crawls pick webhook mode
on their own wherever a signing secret is configured and fall back to polling
where there is none, so a laptop and production differ by an environment
variable rather than a code path (`convex/licensing.ts`).

Firecrawl found a published contact address for five of the twelve shortlisted
facilities. The other seven keep their place on the board with their inspection
record and the CMS phone number, labelled as having no published address —
hiding them would reproduce exactly the filtering this project exists to
document. Three of the five discoveries needed a retry through a rate limit and
got one.

Two things are not right yet and are worth writing down. Dedicated per-search
AgentMail inboxes are not being created — the call fails to resolve and every
search falls back to the shared organisation inbox, correctly labelled in the UI
but not the multi-inbox architecture intended. The dev deployment shows the same
fallback on every past run, so this predates the deployment rather than being
caused by it. Separately, production is still pointed at the build-time model
provider, whose free tier caps at 500 requests a day; that cap was reached
during the verification run and several reply parses failed against it. The
shipping provider switch in `convex/ai/provider.ts` is a one-variable change and
is the next thing to do.


### 2026-09-05 - eb714ca
Per-search AgentMail inboxes provision, which closes the first of the two gaps
the last entry left open. There were two causes and both were real. The
component ships its inbox and thread calls as `internalAction`, so a mounting
app cannot reference them at all and the call never resolved;
`patches/@agentmail+convex+0.1.0.patch` now exposes createInbox, listInboxes,
getInboxRemote, deleteInbox, listThreads, getThread and getMessage as public
actions, alongside the env declaration that patch already carried. Underneath
that, AgentMail validates `client_id` against `/^[A-Za-z0-9._~-]+$/` and our
purpose keys are colon-separated, so every create came back 400. The colons now
collapse to hyphens through one stable mapping, which is the part that matters:
`client_id` is an idempotency key, so the same purpose has to produce the same
value or a retry would open a second inbox (`convex/email.ts`).

Falling back to the shared inbox is no longer permanent. `provisionInbox`
returned whatever row it found, so once a purpose had fallen back, fixing the
underlying cause could not heal it and the only way out was deleting the row by
hand. A dedicated row still short-circuits; a shared one is retried and upgraded
in place the first time the retry succeeds.

Tooling for the provider switch is in, but the switch has not happened.
`deficiencies:resetTranslationCache` clears the translation cache in
self-chaining batches of 200, optionally filtered by the `model` prefix that
records who wrote each row, so a half-re-warmed cache can drop one provider's
rows and keep the other's — two facilities described in two different registers
is visible on camera (`convex/deficiencies.ts`). Production still runs the
build-time provider; that remains the next thing to do.

### 2026-09-05 - working tree
A comprehension pass over the interface. No backend change: every number below
was already a live Convex subscription, and this is the same data made legible.

The front page now states what the product is before it states what is wrong
with the incumbent. The thesis it was built around — public records tell you
whether a facility is safe, only email tells you whether it is available — was
nowhere on screen, and the mechanism that makes the second half possible was
not shown at all, so a reader had no way to see why a federal record and an
inbox are hard to connect. Both are now on the page, the second as three
numbered steps naming what does the work at each one (`src/App.tsx`). The row
of `CCN 055016` buttons is gone; the facility names in the comparison are the
way into the full record, which is where a reader was already looking
(`src/Compare.tsx`). That section also carried the page's second `<h1>` and
opened with two dense paragraphs of caching and crawl statistics before a
single fact about a nursing home — it is an `<h2>` now, and those notes sit
underneath the records they annotate.

On the board, the live counters are a boxed scoreboard rather than a line of
small text, and a progress bar tracks replies against the facilities we can
actually write to — never against the whole shortlist, since a facility that
publishes no address can never answer and would hold the bar permanently short
of the end. The board has always been sorted (openings first, then by
inspection record) and never said so, so a deliberate order was
indistinguishable from none; it says so now. The column headings are sticky,
because the distinction between what an inspector recorded and what a facility
claims is the whole product and should not scroll away, and each row rules its
two halves apart instead of separating them with whitespace. The five questions
every facility is asked are listed on the board — the right-hand column was
full of answers to questions the screen never stated. The demo-mode disclosure
was the tail of a muted sentence after the inbox address; it is its own notice
now, because not sending hackathon traffic to understaffed nursing homes is a
decision and reads as a limitation when it looks like an afterthought
(`src/Board.tsx`).

In a thread, outbound letters were labelled "The family". A family did not
write them — an agent drafted them from what the family said it needed — so
they now read "Ombuds, for the family", with a Sent/Reply marker on each
message (`src/ThreadView.tsx`).

One thing found and not fixed: `rankSearch` in `convex/agentLoop.ts` is a
complete agent action, with its own tools and thread, that nothing calls. The
ranking it would produce is a listed use of the model provider and is currently
invisible in the product.
