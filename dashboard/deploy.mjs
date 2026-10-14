// Publish the dashboard to Vercel so it can be opened from another machine.
//
//   npm run dashboard:deploy
//
// Builds dashboard/hosted/ (page + /api/state + snapshot.json) and runs
// `vercel deploy --prod`. Balances are read live from Base; the catalog and
// the 1Claw quote/allow/deny/paid feed are a snapshot from this run, so
// redeploy to refresh them. Nothing secret is included.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const OUT = join(HERE, "hosted");
const demo = JSON.parse(readFileSync(join(ROOT, "demo.json"), "utf8"));

let catalog = { conferences: [] };
try {
  catalog = await (await fetch(`${demo.seller.url}/catalog`, { signal: AbortSignal.timeout(20000) })).json();
} catch {
  console.warn("! seller not reachable — catalog will be empty (start it with npm run seller:serve)");
}

// Public event fields only; drop the localhost URLs.
const events = (existsSync(join(ROOT, "events.jsonl")) ? readFileSync(join(ROOT, "events.jsonl"), "utf8") : "")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .map(({ at, type, slug, amount_usd, count, reason, tx, dry_run }) => ({ at, type, slug, amount_usd, count, reason, tx, dry_run }));

writeFileSync(join(OUT, "snapshot.json"), JSON.stringify({ taken_at: new Date().toISOString(), demo, catalog, events }, null, 2));
copyFileSync(join(HERE, "index.html"), join(OUT, "index.html"));
console.log(`snapshot: ${catalog.conferences.length} conferences, ${events.length} events`);

const scope = process.env.VERCEL_SCOPE ? ["--scope", process.env.VERCEL_SCOPE] : [];
execFileSync("vercel", ["deploy", "--prod", "--yes", ...scope], { cwd: OUT, stdio: "inherit" });
