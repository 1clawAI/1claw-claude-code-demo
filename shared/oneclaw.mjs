// Shared 1Claw helpers for the seller and buyer scripts.
import { createClient } from "@1claw/sdk";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const API_URL = process.env.ONECLAW_BASE_URL ?? "https://api.1claw.co";

// Base mainnet. CAIP-2 id for x402 v2, chain name for 1Claw tx policy.
export const NETWORK = "eip155:8453";
export const CHAIN = "base";
// 1Claw signing keys are per curve family, not per EVM chain: x402 pay.sign
// looks for the agent's `ethereum` key, and that same address works on Base.
export const KEY_CHAIN = "ethereum";
export const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // USDC on Base
const RPC = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";

/** Load `<dir>/.env` into process.env if present (each agent has its own). */
export function loadEnv(dir) {
  const file = join(dir, ".env");
  if (existsSync(file)) process.loadEnvFile(file);
}

/** Client authenticated as this directory's agent (ocv_ key → agent JWT). */
export function agentClient() {
  const apiKey = process.env.ONECLAW_AGENT_API_KEY;
  if (!apiKey) throw new Error("ONECLAW_AGENT_API_KEY is not set — run `npm run bootstrap` first");
  return createClient({ baseUrl: API_URL, apiKey, agentId: process.env.ONECLAW_AGENT_ID });
}

/** Every SDK call returns { data, error, meta }. Turn an error into a throw. */
export function unwrap(res, what) {
  if (res.error) {
    const status = res.meta?.status ?? "?";
    throw new Error(`${what} failed (${status} ${res.error.type}): ${res.error.message}`);
  }
  return res.data;
}

/** The agent's EVM address on Base, from its HSM-held signing key. */
export async function baseAddress(client, agentId) {
  const { keys = [] } = unwrap(await client.signingKeys.list(agentId), "list signing keys") ?? {};
  const key = keys.find((k) => k.chain === KEY_CHAIN && k.is_active) ?? keys.find((k) => k.is_active && k.address?.startsWith("0x"));
  if (!key?.address) throw new Error(`agent ${agentId} has no ${KEY_CHAIN} signing key — re-run bootstrap`);
  return key.address;
}

/** USDC balance on Base via a plain eth_call (no 1Claw involved). */
export async function usdcBalance(address) {
  const data = "0x70a08231" + address.slice(2).toLowerCase().padStart(64, "0");
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: USDC, data }, "latest"] }),
  });
  const { result } = await res.json();
  return Number(BigInt(result ?? "0x0")) / 1e6;
}
