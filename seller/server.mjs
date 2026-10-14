// LeadForge storefront: conference lead lists sold per lead over x402 v2,
// settled in USDC on Base mainnet.
//
//   GET /catalog                         free: what's for sale, counts, price
//   GET /leads/:slug?title=&min_score=&limit=   paid: $0.01 × leads returned
//
// 1Claw provides everything sensitive: the inventory (vault leads/*), the
// facilitator credentials (vault cdp/*), and the payTo address (the agent's
// HSM-held Base key — nothing on this box can spend from it).
import express from "express";
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createFacilitatorConfig } from "@coinbase/x402";
import { loadEnv, agentClient, unwrap, baseAddress, NETWORK } from "../shared/oneclaw.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
loadEnv(HERE);

const PORT = Number(process.env.SELLER_PORT ?? 4021);
const VAULT = process.env.ONECLAW_VAULT_ID;
const PRICE_PER_LEAD_USD = Number(process.env.PRICE_PER_LEAD_USD ?? "0.01");
const MAX_LIMIT = 100;

const client = agentClient();
const agentId = process.env.ONECLAW_AGENT_ID ?? unwrap(await client.agents.getSelf(), "whoami").id;
const payTo = await baseAddress(client, agentId);

// ── Facilitator: Coinbase CDP (required for Base mainnet), creds from vault ──
const cdpId = unwrap(await client.secrets.get(VAULT, "cdp/api-key-id"), "read cdp/api-key-id").value;
const cdpSecret = unwrap(await client.secrets.get(VAULT, "cdp/api-key-secret"), "read cdp/api-key-secret").value;
const facilitator = new HTTPFacilitatorClient(createFacilitatorConfig(cdpId, cdpSecret));
const resourceServer = new x402ResourceServer(facilitator).register(NETWORK, new ExactEvmScheme());

// ── Inventory, read from the vault (cached briefly) ─────────────────────────
let cache = { at: 0, lists: new Map() };
async function inventory() {
  if (Date.now() - cache.at < 60_000) return cache.lists;
  const { secrets = [] } = unwrap(await client.secrets.list(VAULT, "leads/"), "list inventory") ?? {};
  const lists = new Map();
  for (const s of secrets.filter((s) => s.path.startsWith("leads/"))) {
    const { value } = unwrap(await client.secrets.get(VAULT, s.path), `read ${s.path}`);
    const list = JSON.parse(value);
    lists.set(list.conference.slug, list);
  }
  cache = { at: Date.now(), lists };
  return lists;
}

function select(list, q) {
  const title = String(q.title ?? "").toLowerCase();
  const minScore = Number(q.min_score ?? 0);
  const limit = Math.min(Math.max(Number(q.limit ?? 25), 1), MAX_LIMIT);
  return list.leads
    .filter((l) => (!title || l.title.toLowerCase().includes(title)) && l.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

const usd = (n) => `$${n.toFixed(2)}`;
const mask = (email) => email.replace(/^(.).*@/, "$1•••@");

const app = express();
app.set("trust proxy", true);

app.get("/", (_req, res) => res.redirect("/catalog"));

app.get("/catalog", async (_req, res) => {
  const lists = await inventory();
  res.json({
    seller: { name: "LeadForge", agent_id: agentId, pay_to: payTo, network: NETWORK, asset: "USDC" },
    pricing: { per_lead_usd: PRICE_PER_LEAD_USD, max_limit: MAX_LIMIT, note: "price = per_lead × leads returned after filters" },
    query: { title: "substring match on job title", min_score: "0-100 intent score", limit: `1-${MAX_LIMIT}, default 25` },
    conferences: [...lists.values()].map(({ conference, leads }) => ({
      ...conference,
      leads: leads.length,
      endpoint: `/leads/${conference.slug}`,
      titles: Object.entries(leads.reduce((m, l) => ((m[l.title] = (m[l.title] ?? 0) + 1), m), {}))
        .sort((a, b) => b[1] - a[1])
        .map(([title, n]) => ({ title, n })),
      sample: (({ name, title, company, email, score }) => ({ name, title, company, email: mask(email), score }))(leads[0]),
    })),
  });
});

// Unknown list or empty filter → 404 before anyone is asked to pay.
app.get("/leads/:slug", async (req, res, next) => {
  const list = (await inventory()).get(req.params.slug);
  if (!list) return res.status(404).json({ error: "no such conference", catalog: "/catalog" });
  const picked = select(list, req.query);
  if (!picked.length) return res.status(404).json({ error: "no leads match those filters" });
  res.locals.list = list;
  res.locals.picked = picked;
  next();
});

app.use(
  paymentMiddleware(
    {
      "GET /leads/:slug": {
        accepts: [
          {
            scheme: "exact",
            network: NETWORK,
            payTo,
            maxTimeoutSeconds: 120,
            // Quote is computed from the same filters the paid response uses.
            price: async (ctx) => {
              const slug = decodeURIComponent(ctx.path.split("/").pop());
              const list = (await inventory()).get(slug);
              const q = Object.fromEntries(new URL(ctx.adapter.getUrl()).searchParams);
              const n = list ? select(list, q).length : 1;
              return usd(Math.max(n, 1) * PRICE_PER_LEAD_USD);
            },
          },
        ],
        description: "LeadForge conference lead list",
        mimeType: "application/json",
      },
    },
    resourceServer,
  ),
);

app.get("/leads/:slug", (req, res) => {
  const { list, picked } = res.locals;
  const amount = usd(picked.length * PRICE_PER_LEAD_USD);
  res.on("finish", () => recordSale({ slug: req.params.slug, count: picked.length, amount, query: req.query, res }));
  res.json({ conference: list.conference, filters: req.query, count: picked.length, price_usd: amount, leads: picked });
});

// Receipts go to the seller's vault (sales/*) and a local tail-able log.
async function recordSale({ slug, count, amount, query, res }) {
  if (res.statusCode !== 200) return;
  const settlement = res.getHeader("PAYMENT-RESPONSE") ?? res.getHeader("X-PAYMENT-RESPONSE");
  let tx = null;
  try {
    tx = settlement ? JSON.parse(Buffer.from(String(settlement), "base64").toString()) : null;
  } catch {}
  const receipt = { at: new Date().toISOString(), slug, count, amount, query, payer: tx?.payer, tx: tx?.transaction, network: NETWORK };
  appendFileSync(join(HERE, "sales.log"), JSON.stringify(receipt) + "\n");
  console.log(`💰 SOLD ${count} leads from ${slug} for ${amount}${tx?.transaction ? `  tx ${tx.transaction}` : ""}`);
  const r = await client.secrets.set(VAULT, `sales/${receipt.at.replace(/[:.]/g, "-")}`, JSON.stringify(receipt), { type: "note" });
  if (r.error) console.warn(`  (receipt not saved to vault: ${r.error.message})`);
}

app.listen(PORT, () => {
  console.log(`LeadForge listening on http://localhost:${PORT}`);
  console.log(`  agent   ${agentId}`);
  console.log(`  pay_to  ${payTo}  (${NETWORK}, USDC)`);
  console.log(`  price   ${usd(PRICE_PER_LEAD_USD)} / lead`);
});
