// Apply the buyer's x402 pay guardrails in one PATCH, authorized by a
// single-use re-auth token. Widening (enable pay, raise the daily limit, add a
// payee, drop the per-payment passkey) needs StrongFactor step-up, and the
// dashboard has no control for it yet. Get a `rat_` token by re-authenticating
// with your passkey on the 1Claw dashboard origin for purpose
// `security.agent_pay_guardrails.widen`, then:
//
//   npm run guardrails -- rat_xxxxxxxx
//
// The token is single-use, which is why everything goes in one request.
import { createClient } from "@1claw/sdk";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { API_URL, unwrap } from "../shared/oneclaw.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
if (existsSync(join(ROOT, ".env.human"))) process.loadEnvFile(join(ROOT, ".env.human"));

const token = process.argv[2] ?? process.env.ONECLAW_REAUTH_TOKEN;
if (!token?.startsWith("rat_")) {
  console.error("usage: npm run guardrails -- rat_...   (single-use re-auth token, purpose security.agent_pay_guardrails.widen)");
  process.exit(2);
}

const buyerEnv = readFileSync(join(ROOT, "buyer", ".env"), "utf8");
const get = (k) => buyerEnv.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1];
const buyerId = get("ONECLAW_AGENT_ID");
const sellerAddress = get("SELLER_ADDRESS");

const guardrails = {
  pay_enabled: true,
  pay_max_usd: "0.50",
  pay_daily_limit_usd: "3.00",
  pay_payto_allowlist: [sellerAddress],
  pay_require_passkey: false,
  pay_require_approval: false,
};

const human = createClient({ baseUrl: API_URL, apiKey: process.env.ONECLAW_API_KEY });
// pay.updateSettings() has no header slot; use the same authenticated transport.
const res = await human.pay.http.request("PATCH", `/v1/agents/${buyerId}/pay/settings`, {
  body: guardrails,
  headers: { "X-Auth-Confirm": token },
});
console.log(JSON.stringify(unwrap(res, "update pay guardrails"), null, 2));
