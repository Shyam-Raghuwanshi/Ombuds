#!/usr/bin/env node
/**
 * Golden fixture runner. CLAUDE.md section 11.5.
 *
 *   npm run fixtures            -> writes fixtures/<provider>-<date>.md
 *
 * Run it before the Sep 15 provider switch and again after, then diff the two
 * files. This catches tone and format drift in minutes, which is the failure
 * mode a schema check cannot see.
 *
 * It calls the same cached action the product uses, so a second run is free.
 */
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";
import { TRANSLATION_FIXTURES } from "../convex/ai/fixtures.ts";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);

const client = new ConvexHttpClient(env.VITE_CONVEX_URL);

const rows = [];
for (const f of TRANSLATION_FIXTURES) {
  process.stderr.write(`${f.tag}/${f.scopeSeverity} … `);
  const r = await client.action(api.deficiencies.translateDeficiency, {
    tag: f.tag,
    tagDescription: f.tagDescription,
    scopeSeverity: f.scopeSeverity,
  });
  process.stderr.write(`${r.cached ? "cached" : "generated"} (${r.model})\n`);
  rows.push({ ...f, ...r });
}

const model = rows[0]?.model ?? "unknown";
const provider = model.split(":")[0];
const stamp = new Date().toISOString().slice(0, 10);
mkdirSync(new URL("../fixtures/", import.meta.url), { recursive: true });
const out = new URL(`../fixtures/${provider}-${stamp}.md`, import.meta.url);

writeFileSync(
  out,
  [
    `# Golden translation fixtures — ${model}`,
    ``,
    `Generated ${new Date().toISOString()}.`,
    `Ten real (tag, scope/severity) pairs from the federal record of the three`,
    `demo facilities. Diff this file against the run from the other provider.`,
    ``,
    ...rows.map((r) =>
      [
        `## ${r.tag} · severity ${r.scopeSeverity} · ${r.harmLevel} · ${r.spread}`,
        ``,
        `**CMS requirement:** ${r.tagDescription}`,
        ``,
        `**Seen at:** ${r.seenAt}`,
        ``,
        `**Plain English (cached, shared by every facility):**`,
        ``,
        `> ${r.plainEnglish}`,
        ``,
      ].join("\n"),
    ),
  ].join("\n"),
);

console.error(`\nWrote ${out.pathname}`);
