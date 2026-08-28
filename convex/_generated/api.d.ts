/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as ai_fixtures from "../ai/fixtures.js";
import type * as ai_provider from "../ai/provider.js";
import type * as ai_schemas from "../ai/schemas.js";
import type * as auth from "../auth.js";
import type * as cms from "../cms.js";
import type * as deficiencies from "../deficiencies.js";
import type * as enrichment from "../enrichment.js";
import type * as http from "../http.js";
import type * as lib_contact from "../lib/contact.js";
import type * as lib_firecrawlErrors from "../lib/firecrawlErrors.js";
import type * as lib_licensing from "../lib/licensing.js";
import type * as lib_severity from "../lib/severity.js";
import type * as licensing from "../licensing.js";
import type * as news from "../news.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "ai/fixtures": typeof ai_fixtures;
  "ai/provider": typeof ai_provider;
  "ai/schemas": typeof ai_schemas;
  auth: typeof auth;
  cms: typeof cms;
  deficiencies: typeof deficiencies;
  enrichment: typeof enrichment;
  http: typeof http;
  "lib/contact": typeof lib_contact;
  "lib/firecrawlErrors": typeof lib_firecrawlErrors;
  "lib/licensing": typeof lib_licensing;
  "lib/severity": typeof lib_severity;
  licensing: typeof licensing;
  news: typeof news;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  agent: import("@convex-dev/agent/_generated/component.js").ComponentApi<"agent">;
  agentmail: import("@agentmail/convex/_generated/component.js").ComponentApi<"agentmail">;
  firecrawl: import("@firecrawl/firecrawl-convex/_generated/component.js").ComponentApi<"firecrawl">;
  staticHosting: import("@convex-dev/static-hosting/_generated/component.js").ComponentApi<"staticHosting">;
  inquiryPool: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"inquiryPool">;
  enrichmentPool: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"enrichmentPool">;
};
