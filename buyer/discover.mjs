// Find a lead seller: search the 1Claw agent directory, then read the
// seller's free catalog. Prints JSON for the agent to reason over.
//
//   node buyer/discover.mjs [search terms]
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, agentClient } from "../shared/oneclaw.mjs";

loadEnv(dirname(fileURLToPath(import.meta.url)));
const client = agentClient();
const q = process.argv.slice(2).join(" ") || "conference leads";

// Same-org directory first (both demo agents live in one org), then public.
const found = [];
for (const [scope, call] of [
  ["org", () => client.discovery.orgDirectory({ q })],
  ["public", () => client.discovery.directory({ q, tags: "leads" })],
]) {
  const res = await call();
  if (res.error) {
    console.error(`(${scope} directory unavailable: ${res.error.message})`);
    continue;
  }
  for (const a of res.data?.agents ?? []) found.push({ scope, ...a });
}

// The directory listing advertises the storefront URL in its description.
const advertised = found.map((a) => a.description?.match(/https?:\/\/\S+\/catalog/)?.[0]).find(Boolean);
const catalogUrl = advertised ?? `${process.env.SELLER_URL}/catalog`;

let catalog = null;
try {
  catalog = await (await fetch(catalogUrl)).json();
} catch (e) {
  console.error(`could not reach ${catalogUrl}: ${e.message} — is the seller running?`);
}

console.log(JSON.stringify({ query: q, directory: found, catalog_url: catalogUrl, catalog }, null, 2));
