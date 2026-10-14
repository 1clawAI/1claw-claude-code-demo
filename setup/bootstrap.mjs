// Human-run, once. Provisions everything both agents need on 1Claw:
//
//   seller "LeadForge"   vault leadforge-seller   (leads/**, sales/**, cdp/**)
//   buyer  "Pipeline"    vault pipeline-buyer     (purchased/**)
//
// Each agent gets an HSM-held Base signing key, a vault grant scoped to its
// own vault only, and an agent API key written to <agent>/.env. The buyer's
// x402 guardrails (per-payment cap, daily cap, pay-to allowlist = seller's
// address) are set here, by a human, because an agent cannot set its own.
//
//   cp .env.human.example .env.human && $EDITOR .env.human
//   npm run bootstrap            # add --force to mint fresh agents
import { createClient } from "@1claw/sdk";
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { API_URL, CHAIN, KEY_CHAIN, unwrap } from "../shared/oneclaw.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FORCE = process.argv.includes("--force");

if (existsSync(join(ROOT, ".env.human"))) process.loadEnvFile(join(ROOT, ".env.human"));
const { ONECLAW_API_KEY, ONECLAW_PASSWORD, CDP_API_KEY_ID, CDP_API_KEY_SECRET } = process.env;
if (!ONECLAW_API_KEY?.startsWith("1ck_")) {
  console.error("Set ONECLAW_API_KEY=1ck_... in .env.human (see .env.human.example)");
  process.exit(1);
}

const human = createClient({ baseUrl: API_URL, apiKey: ONECLAW_API_KEY });
const PORT = process.env.SELLER_PORT ?? "4021";

// Spend policy for the buyer. Real USDC on Base mainnet, so keep it small.
const BUYER_PAY = { perPaymentUsd: "0.50", dailyUsd: "3.00" };

async function ensureVault(name, description) {
  const { vaults = [] } = unwrap(await human.vault.list(), "list vaults") ?? {};
  const found = vaults.find((v) => v.name === name);
  if (found) return found;
  return unwrap(await human.vault.create({ name, description }), `create vault ${name}`);
}

function readEnv(dir) {
  const file = join(ROOT, dir, ".env");
  if (!existsSync(file)) return null;
  return Object.fromEntries(
    readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.includes("=") && !l.startsWith("#"))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
}

async function ensureAgent(dir, spec, vault) {
  const existing = !FORCE && readEnv(dir);
  if (existing?.ONECLAW_AGENT_ID) {
    console.log(`  ↺ reusing ${spec.name} (${existing.ONECLAW_AGENT_ID}) from ${dir}/.env`);
    return { id: existing.ONECLAW_AGENT_ID, apiKey: existing.ONECLAW_AGENT_API_KEY };
  }
  const created = unwrap(
    await human.agents.create({ ...spec, vault_ids: [vault.id], intents_api_enabled: true, tx_allowed_chains: [CHAIN] }),
    `create agent ${spec.name}`,
  );
  console.log(`  ✓ agent ${spec.name} ${created.agent.id}`);
  return { id: created.agent.id, apiKey: created.api_key };
}

async function ensureBaseKey(agentId) {
  const { keys = [] } = unwrap(await human.signingKeys.list(agentId), "list signing keys") ?? {};
  const have = keys.find((k) => k.chain === KEY_CHAIN && k.is_active);
  if (have) return have.address;
  const key = unwrap(await human.signingKeys.create(agentId, { chain: KEY_CHAIN }), "create signing key");
  return key.address;
}

async function grantOwnVault(vault, agentId, pattern) {
  const res = await human.access.grantAgent(vault.id, agentId, ["read", "write"], { secretPathPattern: pattern });
  if (res.error && res.meta?.status !== 409) unwrap(res, `grant ${pattern}`);
}

function writeAgentEnv(dir, values) {
  const body = Object.entries(values).map(([k, v]) => `${k}=${v}`).join("\n");
  writeFileSync(join(ROOT, dir, ".env"), `# Written by setup/bootstrap.mjs — this agent's identity only.\n${body}\n`, { mode: 0o600 });
}

console.log("\n1Claw bootstrap → Base mainnet (eip155:8453)\n");

// ── Vaults ───────────────────────────────────────────────────────────────
const sellerVault = await ensureVault("leadforge-seller", "LeadForge: conference lead inventory, sales receipts, facilitator creds");
const buyerVault = await ensureVault("pipeline-buyer", "Pipeline: purchased lead lists");
console.log(`  ✓ vaults ${sellerVault.id} (seller), ${buyerVault.id} (buyer)`);

// ── Agents ───────────────────────────────────────────────────────────────
const seller = await ensureAgent(
  "seller",
  {
    name: "leadforge-seller",
    description: "Sells verified conference attendee lead lists over x402 (USDC on Base).",
    // Receive-only: the seller never needs to move funds out.
    tx_max_value: "0",
    tx_daily_limit: "0",
  },
  sellerVault,
);
const buyer = await ensureAgent(
  "buyer",
  { name: "pipeline-buyer", description: "SDR research agent that buys lead lists within a fixed budget." },
  buyerVault,
);

// ── Vault policies: each agent sees only its own vault ───────────────────
await grantOwnVault(sellerVault, seller.id, "**");
await grantOwnVault(buyerVault, buyer.id, "purchased/**");
console.log("  ✓ policies: seller → leadforge-seller/**, buyer → pipeline-buyer/purchased/**");

// ── HSM signing keys on Base ─────────────────────────────────────────────
const sellerAddress = await ensureBaseKey(seller.id);
const buyerAddress = await ensureBaseKey(buyer.id);
console.log(`  ✓ seller payTo  ${sellerAddress}`);
console.log(`  ✓ buyer wallet  ${buyerAddress}`);

// ── Mainnet facilitator creds → seller vault (never on disk) ─────────────
if (CDP_API_KEY_ID && CDP_API_KEY_SECRET) {
  unwrap(await human.secrets.set(sellerVault.id, "cdp/api-key-id", CDP_API_KEY_ID, { type: "api_key" }), "store CDP key id");
  unwrap(await human.secrets.set(sellerVault.id, "cdp/api-key-secret", CDP_API_KEY_SECRET, { type: "api_key" }), "store CDP secret");
  console.log("  ✓ CDP facilitator key stored at leadforge-seller/cdp/*");
} else {
  console.log("  ! CDP_API_KEY_ID/SECRET not set — store them later at leadforge-seller/cdp/api-key-id and cdp/api-key-secret");
}

// ── Buyer x402 guardrails (human-only; widening needs password re-auth) ──
// The SDK's pay.updateSettings() has no header slot, so send X-Auth-Confirm
// through the same authenticated transport it uses.
const guardrails = {
  pay_enabled: true,
  pay_max_usd: BUYER_PAY.perPaymentUsd,
  pay_daily_limit_usd: BUYER_PAY.dailyUsd,
  pay_payto_allowlist: [sellerAddress],
  // Unattended demo: no passkey tap per payment. The caps + allowlist above
  // are what keep this safe. Set true to have a human approve each purchase.
  pay_require_passkey: false,
  pay_require_approval: false,
};
const payRes = await human.pay.http.request("PATCH", `/v1/agents/${buyer.id}/pay/settings`, {
  body: guardrails,
  headers: ONECLAW_PASSWORD ? { "X-Auth-Confirm": ONECLAW_PASSWORD } : undefined,
});
if (payRes.error) {
  console.log(`  ! pay guardrails not applied (${payRes.meta?.status}): ${payRes.error.message}`);
  console.log("    Widening needs passkey step-up. Re-auth on the 1Claw dashboard for purpose");
  console.log("    security.agent_pay_guardrails.widen, then: npm run guardrails -- rat_...");
} else {
  console.log(`  ✓ buyer pay guardrails: ≤ $${BUYER_PAY.perPaymentUsd}/payment, ≤ $${BUYER_PAY.dailyUsd}/day, pay-to = seller only`);
}

// ── Make the seller findable by other agents in the org ──────────────────
const disc = await human.discovery.updateDiscovery(seller.id, {
  discoverable: true,
  public_description: `Conference lead lists, paid per lead via x402 (USDC on Base). Catalog: http://localhost:${PORT}/catalog`,
  public_tags: ["leads", "conferences", "x402", "sales-data"],
});
console.log(disc.error ? `  ! discovery not enabled: ${disc.error.message}` : "  ✓ seller listed in the 1Claw agent directory");

// ── Per-agent env files ──────────────────────────────────────────────────
writeAgentEnv("seller", {
  ONECLAW_AGENT_ID: seller.id,
  ONECLAW_AGENT_API_KEY: seller.apiKey,
  ONECLAW_VAULT_ID: sellerVault.id,
  SELLER_PORT: PORT,
});
writeAgentEnv("buyer", {
  ONECLAW_AGENT_ID: buyer.id,
  ONECLAW_AGENT_API_KEY: buyer.apiKey,
  ONECLAW_VAULT_ID: buyerVault.id,
  SELLER_URL: `http://localhost:${PORT}`,
  SELLER_ADDRESS: sellerAddress,
});

// Public, non-secret metadata for the dashboard.
writeFileSync(
  join(ROOT, "demo.json"),
  JSON.stringify(
    {
      network: "eip155:8453",
      usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      seller: { name: "LeadForge", agent_id: seller.id, address: sellerAddress, url: `http://localhost:${PORT}` },
      buyer: {
        name: "Pipeline",
        agent_id: buyer.id,
        address: buyerAddress,
        guardrails: { per_payment_usd: Number(BUYER_PAY.perPaymentUsd), daily_usd: Number(BUYER_PAY.dailyUsd), pay_to: "LeadForge only" },
      },
    },
    null,
    2,
  ) + "\n",
);

console.log(`
Done. Next:
  1. Fund the buyer with a few dollars of USDC on Base (no ETH needed — the facilitator pays gas):
       ${buyerAddress}
  2. Terminal A:  ./run-seller.sh     (Claude Code as LeadForge)
  3. Terminal B:  ./run-buyer.sh      (Claude Code as Pipeline)
`);
