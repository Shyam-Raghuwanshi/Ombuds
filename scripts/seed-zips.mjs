#!/usr/bin/env node
/**
 * Load the ZIP gazetteer into Convex.
 *
 *   npm run seed:zips            -> dev deployment
 *   npm run seed:zips -- --prod  -> production
 *
 * Source is `data/us-zip-locations.csv`, the GeoNames postal-code export
 * (CC BY 4.0) trimmed to zip, latitude, longitude, city, state. Idempotent:
 * rows are keyed by ZIP, so a re-run refreshes in place. Run it once per
 * deployment, and again only when the gazetteer file itself changes.
 *
 * Goes through `npx convex run` rather than an HTTP client because the upsert
 * is an internal mutation — it must not be callable from a browser.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const prod = process.argv.includes("--prod");
const root = fileURLToPath(new URL("..", import.meta.url));
const csv = readFileSync(new URL("../data/us-zip-locations.csv", import.meta.url), "utf8");

const rows = csv.trimEnd().split("\n").slice(1).map((line) => {
  const [zip, latitude, longitude, city, state] = line.split(",");
  return { zip, latitude: Number(latitude), longitude: Number(longitude), city, state };
});

// Sized to stay inside a single Convex transaction's write budget.
const CHUNK = 1000;
let inserted = 0;
let updated = 0;

for (let i = 0; i < rows.length; i += CHUNK) {
  const batch = rows.slice(i, i + CHUNK);
  const out = execFileSync(
    "npx",
    ["convex", "run", ...(prod ? ["--prod"] : ["--no-push"]), "geo:upsertZipLocations",
     JSON.stringify({ rows: batch })],
    { cwd: root, encoding: "utf8", maxBuffer: 1 << 24 },
  );
  const r = JSON.parse(out);
  inserted += r.inserted;
  updated += r.updated;
  process.stderr.write(`\r${i + batch.length}/${rows.length} ZIPs …`);
}

process.stderr.write("\n");

let size = 0;
let cursor = null;
for (;;) {
  const page = JSON.parse(execFileSync(
    "npx",
    ["convex", "run", ...(prod ? ["--prod"] : ["--no-push"]), "geo:zipGazetteerPage",
     JSON.stringify({ cursor })],
    { cwd: root, encoding: "utf8" },
  ));
  size += page.count;
  if (page.isDone) break;
  cursor = page.cursor;
}
console.log(`${inserted} inserted, ${updated} updated. Gazetteer now holds ${size} ZIPs.`);
if (size !== rows.length) {
  console.error(`Expected ${rows.length}. Seed is incomplete.`);
  process.exit(1);
}
