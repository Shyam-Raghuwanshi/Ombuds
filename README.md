# Ombuds

**Public records tell you whether a care facility is safe. Only email tells you whether it is available. Ombuds does both, and takes no money from facilities.**

**Live app:** https://flexible-reindeer-206.convex.site — no sign-up, no form.

A family looking for a nursing home for a parent usually ends up with a referral service that the facility pays, often around a month's rent per placement. Meanwhile the federal government publishes every inspection failure, fine and staffing figure for all 14,690 Medicare-certified facilities, as tag codes almost nobody can read. Ombuds reads that record in plain English. Then it writes to every facility on the shortlist and asks the five things no facility publishes: current openings, true all-in monthly cost, waitlist, night staffing ratio and tour dates.

Built for the Convex All Gas Hackathon. The dated build log is in [`hackathon.md`](hackathon.md).

---

## Try it in 60 seconds

1. Open the live app. You are signed in anonymously in the background.
2. Press **See a real search**. A board opens with twelve real facilities near Pomona, California, each with its real federal inspection record on the left.
3. Watch the right-hand column. Letters go out through AgentMail within about twenty seconds, and replies start landing about ten seconds after that. The counters at the top move without a refresh.
4. One facility answers everything except the price. Within about a minute the agent writes back **in the same thread**, on its own, and the row fills in with a monthly cost. Press **Read the emails** on that row to see both rounds.
5. Click any facility name for the full federal record. That page shows immediate-jeopardy findings in a red banner, each finding in plain English, the pattern across years, and how the contact address was found.
6. Or go back and choose **Search your own ZIP code**. Every certified facility within range appears as you type.

> **No real facility is emailed.** These are real, understaffed nursing homes caring for vulnerable people, so every letter is addressed to an inbox we control and a scripted persona plays the facility. The letters, the delivery, the parsing and the follow-up are real; the recipient is us. The board and every thread say so. See [`convex/lib/sendGuard.ts`](convex/lib/sendGuard.ts): two separate environment flags, both off by default, must be set before a facility's own address can be returned.

---

## What each sponsor actually does

### OpenAI: reasoning on both halves

Every model call goes through one file, [`convex/ai/provider.ts`](convex/ai/provider.ts), and every response is validated against a zod schema in [`convex/ai/schemas.ts`](convex/ai/schemas.ts).

| Work | Model | Where |
|---|---|---|
| Translate federal citations (`F0689`, severity `G`) into plain English | gpt-5-mini | [`convex/deficiencies.ts`](convex/deficiencies.ts) |
| Describe the pattern across a facility's whole inspection history | gpt-5 | [`convex/deficiencies.ts`](convex/deficiencies.ts) |
| Draft the family's letter and the in-thread follow-up | gpt-5 | [`convex/email.ts`](convex/email.ts) |
| Parse each messy human reply into structured fields with a confidence score | gpt-5 | [`convex/email.ts`](convex/email.ts) |
| Decide whether a reply dodged a question and write back (agent loop with tools) | gpt-5-mini | [`convex/agentLoop.ts`](convex/agentLoop.ts) |
| Decide whether a local news story is about *this* facility, not a same-name one | gpt-5 | [`convex/news.ts`](convex/news.ts) |

Translations are cached by `(tag, severity)` and nothing else, because `F0689` at severity `G` means the same thing in every state. About 420,000 citations nationally share roughly 1,400 cached meanings. Every model call is priced into a per-search ledger shown under the board ([`convex/usage.ts`](convex/usage.ts)); a full sample campaign costs about nine cents.

### Firecrawl: the link between a federal record and an inbox

The federal record has a phone number for every facility and **no website and no email address**. Without Firecrawl there is no way to write to anyone.

- **`search`** finds the facility's own website, with referral networks and directories excluded ([`convex/enrichment.ts`](convex/enrichment.ts), [`convex/lib/contact.ts`](convex/lib/contact.ts)).
- **`map`** finds the admissions or contact page on that site.
- **`scrape`** extracts the contact address plus care levels, room types, amenities and any published pricing as validated JSON. That address is the input to AgentMail.
- **`search`** again, for local news from the past year, because CMS publishes months behind ([`convex/news.ts`](convex/news.ts)).
- **`startCrawl`** runs a durable crawl of New York's adult care facility register. Assisted living is licensed by states and absent from federal data; the crawl found 521 facilities with no federal record. Progress is a live query over the component's crawl row ([`convex/licensing.ts`](convex/licensing.ts)).

Discovery fails often, and the product says so. A facility with no website or no published address keeps its place on the board with its full inspection record and its CMS phone number. Hiding it would be the same filtering a paid referral service does.

### AgentMail: the mechanism, not a notification

- **One inbox per family search**, provisioned when the search starts ([`convex/email.ts`](convex/email.ts), `provisionInbox`). If AgentMail refuses, the search falls back to a shared inbox and the board says so.
- The family's letter goes to every reachable facility as a separate thread, staggered through a bounded workpool.
- **Multi-round:** when a reply leaves a question unanswered or is too vague to plan around, the agent sends one follow-up **in the same thread**. Never more than two rounds.
- One polite nudge after 72 hours of silence, and never a second ([`convex/crons.ts`](convex/crons.ts)).
- Delivery status (`sent → delivered → bounced`) moves the board reactively, from the component's own state and the webhook mounted in [`convex/http.ts`](convex/http.ts). Inbound mail enters through `onMessageReceived` → `ingestInbound`, and the demo personas use that same `ingestInbound` function, so there is one inbound pipeline, not a demo copy.

---

## Convex, used for real

| Feature | Where |
|---|---|
| Reactive queries — the board, threads, crawl progress, the ZIP preview as you type | [`convex/searches.ts`](convex/searches.ts) `board`, [`convex/email.ts`](convex/email.ts) `thread`, [`convex/geo.ts`](convex/geo.ts) `facilitiesNearZip` |
| Mutations and internal mutations — queueing, parsing results, webhook callbacks | [`convex/searches.ts`](convex/searches.ts), [`convex/email.ts`](convex/email.ts) |
| Actions — every OpenAI, Firecrawl and AgentMail call | [`convex/email.ts`](convex/email.ts), [`convex/enrichment.ts`](convex/enrichment.ts), [`convex/news.ts`](convex/news.ts) |
| HTTP router — auth routes, AgentMail webhook, static site | [`convex/http.ts`](convex/http.ts) |
| Crons — nudge sweep, no-response sweep, monthly CMS refresh with harm alerts, stale-answer sweep | [`convex/crons.ts`](convex/crons.ts) |
| Scheduler — staggered sends, persona replies, reply reconciliation, discovery backfill | [`convex/searches.ts`](convex/searches.ts), [`convex/demo.ts`](convex/demo.ts) |
| Indexes — every read goes through one | [`convex/schema.ts`](convex/schema.ts) |
| Pagination — full citation history, crawl pages, licensed facilities | [`src/FacilityDetail.tsx`](src/FacilityDetail.tsx), [`src/LicensingCrawl.tsx`](src/LicensingCrawl.tsx) |
| File storage — download the comparison as a CSV with provenance on every column | [`convex/exports.ts`](convex/exports.ts) |
| Auth — Convex Auth with silent anonymous sign-in | [`convex/auth.ts`](convex/auth.ts), [`src/App.tsx`](src/App.tsx) |
| Components — agent, AgentMail, Firecrawl, static hosting, geospatial (radius search over 14,690 facilities), workpool ×2, rate limiter | [`convex/convex.config.ts`](convex/convex.config.ts) |

Anonymous sign-in means an identity costs nothing, so every entry point that spends money is bounded per visitor and globally ([`convex/limits.ts`](convex/limits.ts)). Cached work is never counted.

---

## Data and provenance

- Federal data comes from the **CMS Provider Data Catalog**: Provider Information, Health Deficiencies (loaded per facility, never in bulk) and the Citation Code Look-up. It is refreshed monthly by cron.
- ZIP code locations come from the **GeoNames postal-code export** ([download.geonames.org/export/zip](https://download.geonames.org/export/zip/)), used under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) and trimmed to `data/us-zip-locations.csv` — 41,705 ZIPs, merged from the US file plus the separate Puerto Rico, Virgin Islands, Guam, Northern Mariana and American Samoa files. CMS places every facility but says nothing about where a ZIP is, and deriving that from the facilities themselves put three quarters of US ZIPs a median of 20.8 miles from their real location.
- Every federal figure shows its inspection date. Every emailed answer is labelled as reported by the facility, with the time it arrived. Model-written text names the model that wrote it.
- Red is used for one thing only: a finding that a resident was harmed or placed in immediate jeopardy.
- Ombuds reports public records and relays what facilities say. It is not medical, legal or financial advice.

---

## Run it locally

Requires Node 20+ and a Convex account.

```bash
npm ci                      # also applies patches/@agentmail+convex+0.1.0.patch
npx convex dev              # creates a dev deployment and writes .env.local
```

Set the deployment's environment variables with `npx convex env set <NAME> <value>`. The names and what each one does are in [`.env.example`](.env.example). Demo mode is on and real sends are off unless you change them.

```bash
npm run seed:zips           # ZIP gazetteer, 41,488 rows; run once per deployment
npm run seed:demo           # CMS tag catalog + three sample facilities; no model calls
npm run dev                 # Vite + convex dev
```

AgentMail and Firecrawl deliver webhooks to a public URL, so inbound replies need a deployed dev deployment rather than localhost. Firecrawl crawls fall back to polling when no webhook secret is set.

Deploy the backend with `npx convex deploy`, then the frontend with `npx @convex-dev/static-hosting deploy --skip-convex`.

### Layout

```
convex/            backend: schema, functions, crons, HTTP routes, components
convex/ai/         the only place a model is named; prompts and zod schemas
convex/lib/        pure helpers: severity grid, contact discovery, send guard, personas
src/               React + Vite + Tailwind frontend
data/              the ZIP gazetteer (GeoNames, CC BY 4.0)
fixtures/          golden translations for diffing a model change
patches/           a patch to @agentmail/convex 0.1.0 (env contract, exposed inbox calls)
```
