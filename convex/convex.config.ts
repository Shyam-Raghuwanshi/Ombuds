import { defineApp } from "convex/server";
import { v } from "convex/values";

import agent from "@convex-dev/agent/convex.config";
import agentmail from "@agentmail/convex/convex.config";
import firecrawl from "@firecrawl/firecrawl-convex/convex.config";
import staticHosting from "@convex-dev/static-hosting/convex.config";
import workpool from "@convex-dev/workpool/convex.config";

// App-owned root routing: `convex/http.ts` keeps the root, so the Convex Auth
// routes and the AgentMail webhook live at stable URLs. Static hosting is
// mounted from inside the router as a catch-all (see convex/http.ts).
const app = defineApp({
  env: {
    FIRECRAWL_API_KEY: v.string(),
    FIRECRAWL_WEBHOOK_SECRET: v.optional(v.string()),
    AGENTMAIL_API_KEY: v.string(),
  },
});

// OpenAI agent loop (deficiency translation, reply parsing, drafting, ranking).
app.use(agent);

// One inbox per family search; inbound replies arrive by webhook.
// The component reads AGENTMAIL_API_KEY from its own process.env at request
// time, but v0.1.0 shipped without declaring an env contract, so a mounting app
// had no way to hand it the key and every send failed. patches/ adds the
// declaration; see the note in that patch file.
app.use(agentmail, {
  env: { AGENTMAIL_API_KEY: app.env.AGENTMAIL_API_KEY },
});

// Facility contact discovery, enrichment, local news, state licensing crawls.
// `httpPrefix` mounts the crawl webhook at <site>/firecrawl/webhook.
app.use(firecrawl, {
  httpPrefix: "/firecrawl/",
  env: {
    FIRECRAWL_API_KEY: app.env.FIRECRAWL_API_KEY,
    FIRECRAWL_WEBHOOK_SECRET: app.env.FIRECRAWL_WEBHOOK_SECRET,
  },
});

// No httpPrefix — the SPA catch-all is registered inside convex/http.ts so it
// cannot shadow the auth or webhook routes.
app.use(staticHosting);

// Bounded concurrency so a 15-facility fan-out does not stampede AgentMail.
app.use(workpool, { name: "inquiryPool" });
// Separate pool so Firecrawl enrichment never queues behind outbound email.
app.use(workpool, { name: "enrichmentPool" });

export default app;
