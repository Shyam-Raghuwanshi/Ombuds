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
  },
});

// OpenAI agent loop (deficiency translation, reply parsing, drafting, ranking).
app.use(agent);

// One inbox per family search; inbound replies arrive by webhook.
app.use(agentmail);

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
