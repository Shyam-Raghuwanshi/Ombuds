import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { registerStaticRoutes } from "@convex-dev/static-hosting";
import { components } from "./_generated/api";
import { auth } from "./auth";
import { agentmail, amCtx } from "./email";

const http = httpRouter();

// Exact routes are registered first; the static catch-all goes last so it can
// never shadow an auth route or a webhook.

// --- Convex Auth: mounts /api/auth/* -----------------------------------------
auth.addHttpRoutes(http);

// --- AgentMail: inbound replies from facilities -------------------------------
// Register this URL in the AgentMail dashboard as
//   https://<deployment>.convex.site/agentmail/webhook
// and copy the signing secret into AGENTMAIL_WEBHOOK_SECRET.
//
// The component verifies the Svix signature, dedupes by event id, and
// dispatches to the two callbacks configured on the client in convex/email.ts:
//   onMessageReceived -> a facility replied
//   onEvent           -> delivered, bounced, rejected
http.route({
  path: "/agentmail/webhook",
  method: "POST",
  // `amCtx` bridges the component's Convex-version type skew; see convex/email.ts.
  handler: httpAction(async (ctx, req) => agentmail.handleWebhook(amCtx(ctx), req)),
});

// Health probe, so the mount can be confirmed from a browser before the
// webhook is registered in the AgentMail dashboard.
http.route({
  path: "/agentmail/health",
  method: "GET",
  handler: httpAction(async () => {
    return new Response(
      JSON.stringify({ ok: true, mount: "/agentmail/webhook" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }),
});

// --- Firecrawl: durable crawl progress ----------------------------------------
// The component mounts its own verified receiver at
//   https://<deployment>.convex.site/firecrawl/webhook
// via `httpPrefix: "/firecrawl/"` in convex/convex.config.ts. Nothing to
// register here; this route is a health probe so the path is greppable and we
// can confirm the deployment is reachable before pointing Firecrawl at it.
http.route({
  path: "/firecrawl/health",
  method: "GET",
  handler: httpAction(async () => {
    return new Response(JSON.stringify({ ok: true, mount: "/firecrawl/webhook" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }),
});

// --- Static hosting: the SPA, served at the root ------------------------------
// Must stay last.
registerStaticRoutes(http, components.staticHosting);

export default http;
