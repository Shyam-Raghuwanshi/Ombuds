import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { registerStaticRoutes } from "@convex-dev/static-hosting";
import { components } from "./_generated/api";
import { auth } from "./auth";

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
// STUB: delegates to `agentmail.handleWebhook(ctx, req)` once the client is
// constructed in convex/email.ts with its `onMessageReceived` callback.
http.route({
  path: "/agentmail/webhook",
  method: "POST",
  handler: httpAction(async (_ctx, _req) => {
    return new Response(
      JSON.stringify({ ok: false, error: "AgentMail webhook not wired yet" }),
      { status: 501, headers: { "content-type": "application/json" } },
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
