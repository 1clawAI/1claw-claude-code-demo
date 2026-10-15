// Buy a lead list over x402, paying with this agent's 1Claw-held Base key.
//
//   node buyer/buy.mjs "<url>" ["<url>" ...] [--max-usd 0.50] [--dry-run]
//
// Several URLs are bought in parallel in one run (one tool call for the agent);
// --max-usd applies to each payment. 1Claw checks the guardrails on every one.
//
// Flow: GET → 402 challenge → 1Claw pay.prepare (vault checks guardrails:
// per-payment cap, daily cap, pay-to allowlist) → pay.sign (HSM signs an
// EIP-3009 USDC authorization; the key never leaves 1Claw) → retry with the
// payment header → seller settles on Base → save the list to the buyer vault.
//
// The raw 402 bytes are forwarded to 1Claw verbatim: the vault computes the
// digest it authorizes from them, so nothing here parses-and-resends fields.
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, agentClient, unwrap } from "../shared/oneclaw.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
loadEnv(HERE);

const args = process.argv.slice(2);
const urls = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--max-usd");
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => args[args.indexOf(`--${name}`) + 1];
const maxUsd = flag("max-usd") ? Number(opt("max-usd")) : Infinity;
if (!urls.length) {
  console.error('usage: node buyer/buy.mjs "<seller-url>/leads/<slug>?title=...&limit=..." [--max-usd N] [--dry-run]');
  process.exit(2);
}

const client = agentClient();
const agentId = process.env.ONECLAW_AGENT_ID;
const VAULT = process.env.ONECLAW_VAULT_ID;

async function buy(url) {
const slug = new URL(url).pathname.split("/").pop();
const log = (...m) => console.error(`[${slug}]`, ...m); // progress → stderr, result JSON → stdout
// Public, non-secret events for the demo dashboard (../events.jsonl).
const emit = (type, fields = {}) =>
  appendFileSync(join(HERE, "..", "events.jsonl"), JSON.stringify({ at: new Date().toISOString(), type, slug, url, ...fields }) + "\n");

// ── 1. Probe ──────────────────────────────────────────────────────────────
const first = await fetch(url);
const firstBody = Buffer.from(await first.arrayBuffer());
if (first.status !== 402) {
  log(`${first.status} — no payment required`);
  return { url, ok: first.ok, status: first.status, body: firstBody.toString().slice(0, 300) };
}

// x402 v2 carries the challenge in PAYMENT-REQUIRED; v1 in the body.
const headerChallenge = first.headers.get("payment-required");
const challengeB64 = headerChallenge?.trim() ?? firstBody.toString("base64");
const challenge = JSON.parse(Buffer.from(challengeB64, "base64").toString()); // display only
const accept = challenge.accepts?.[0] ?? {};
const quoteUsd = Number(accept.amount ?? accept.maxAmountRequired ?? 0) / 1e6; // USDC has 6 decimals
log(`402 │ quote ${quoteUsd.toFixed(2)} USDC → ${accept.payTo} on ${accept.network}`);
emit("quote", { amount_usd: quoteUsd, pay_to: accept.payTo, dry_run: flag("dry-run") });

if (quoteUsd > maxUsd) {
  log(`✗ quote exceeds --max-usd ${maxUsd}; not paying`);
  emit("skip", { amount_usd: quoteUsd, reason: `over the agent's own --max-usd ${maxUsd}` });
  return { url, ok: false, skipped: `quote $${quoteUsd} > --max-usd ${maxUsd}` };
}
if (process.env.SELLER_ADDRESS && accept.payTo?.toLowerCase() !== process.env.SELLER_ADDRESS.toLowerCase()) {
  log(`! payTo ${accept.payTo} is not the seller address from bootstrap (${process.env.SELLER_ADDRESS}); 1Claw's allowlist will decide`);
}

// ── 2. Ask the vault ──────────────────────────────────────────────────────
const prepRes = await client.pay.prepare(agentId, {
  challenge_b64: challengeB64,
  method: "GET",
  resource_url: url,
  idempotency_key: randomUUID(),
  mode: "strict",
});
if (prepRes.error) {
  emit("deny", { amount_usd: quoteUsd, reason: prepRes.error.message });
  log(`✗ 1Claw refused to prepare this payment (${prepRes.meta?.status}): ${prepRes.error.message}`);
  return { url, ok: false, denied: prepRes.error.message };
}
const prepared = prepRes.data;
log(`1claw │ authorization: ${prepared.authorization}  (session ${prepared.session_id})`);
emit(prepared.authorization === "allow" ? "allow" : "deny", {
  amount_usd: quoteUsd,
  reason: prepared.authorization,
  dry_run: flag("dry-run"),
});

if (prepared.authorization !== "allow") {
  log(`✗ 1Claw did not allow this payment: ${prepared.authorization}`);
  log("  A human can approve it in the 1Claw dashboard, or adjust the buyer's pay guardrails.");
  return { url, ok: false, denied: prepared.authorization, quote_usd: quoteUsd };
}
if (flag("dry-run")) {
  log("dry run — stopping before signing");
  return { url, ok: true, dry_run: true, quote_usd: quoteUsd, authorization: prepared.authorization };
}

// ── 3. HSM signs; we only ever see the signature ──────────────────────────
const signed = unwrap(await client.pay.sign(agentId, { session_id: prepared.session_id, mode: "strict" }), "1claw pay.sign");
log(`1claw │ signed $${signed.amount_usd} to ${signed.pay_to}  (payment ${signed.payment_id})`);

// ── 4. Present payment (v2 header + v1 alias) ─────────────────────────────
// 1Claw returns a hybrid envelope (x402Version 1, network "base", plus a v2
// `accepted` block) that the CDP facilitator rejects for a v2 challenge.
// The signature only covers `payload.authorization`, so re-wrapping it as a
// clean v2 PaymentPayload is safe.
let paymentHeader = signed.payment_header;
if (challenge.x402Version === 2) {
  const raw = JSON.parse(Buffer.from(signed.payment_header, "base64").toString());
  if (raw.x402Version !== 2) {
    const v2 = { x402Version: 2, resource: challenge.resource, accepted: raw.accepted ?? accept, payload: raw.payload };
    paymentHeader = Buffer.from(JSON.stringify(v2)).toString("base64");
  }
}
const paid = await fetch(url, {
  headers: { "PAYMENT-SIGNATURE": paymentHeader, "X-PAYMENT": paymentHeader },
});
const paidText = await paid.text();
const settlementHeader = paid.headers.get("payment-response") ?? paid.headers.get("x-payment-response");
let settlement = null;
try {
  settlement = settlementHeader ? JSON.parse(Buffer.from(settlementHeader, "base64").toString()) : null;
} catch {}

await client.pay
  .reportResult(agentId, signed.payment_id, { http_status: paid.status, settled: paid.ok ? true : undefined })
  .catch(() => {}); // advisory only

if (!paid.ok) {
  emit("error", { amount_usd: Number(signed.amount_usd), reason: `seller returned ${paid.status}` });
  const why = paid.headers.get("payment-required"); log(`✗ seller returned ${paid.status}: ${why ? JSON.parse(Buffer.from(why, "base64").toString()).error : paidText.slice(0, 300)}`);
  return { url, ok: false, error: `seller returned ${paid.status}` };
}
log(`${paid.status} │ paid${settlement?.transaction ? `  tx https://basescan.org/tx/${settlement.transaction}` : ""}`);

// ── 5. Keep it: buyer vault (system of record) + local working copy ──────
const result = JSON.parse(paidText);
emit("paid", { amount_usd: Number(signed.amount_usd), count: result.count, tx: settlement?.transaction ?? null });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const path = `purchased/${result.conference.slug}/${stamp}`;
const record = { ...result, purchase: { url, amount_usd: signed.amount_usd, payment_id: signed.payment_id, tx: settlement?.transaction ?? null } };

const saved = await client.secrets.set(VAULT, path, JSON.stringify(record), {
  type: "note",
  metadata: { conference: result.conference.name, count: result.count, amount_usd: signed.amount_usd },
});
log(saved.error ? `! not saved to vault: ${saved.error.message}` : `vault │ saved to pipeline-buyer/${path}`);

mkdirSync(join(HERE, "out"), { recursive: true });
const localFile = join(HERE, "out", `${result.conference.slug}-${stamp}.json`);
writeFileSync(localFile, JSON.stringify(record, null, 2));

return {
  url,
  ok: true,
  conference: result.conference.name,
  count: result.count,
  paid_usd: signed.amount_usd,
  tx: settlement?.transaction ? `https://basescan.org/tx/${settlement.transaction}` : null,
  vault_path: path,
  local_file: localFile,
};
}

const results = await Promise.all(urls.map((u) => buy(u).catch((e) => ({ url: u, ok: false, error: e.message }))));
console.log(JSON.stringify(urls.length === 1 ? results[0] : results, null, 2));
process.exit(results.every((r) => r.ok) ? 0 : 1);
