// Demo dashboard: a read-only observer. It holds no 1Claw credentials and
// sees only public things: the seller's catalog, sale receipts, the buyer's
// payment events, and on-chain USDC balances on Base.
//
//   npm run dashboard   →  http://localhost:4020
import express from "express";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const PORT = Number(process.env.DASHBOARD_PORT ?? 4020);
const RPC = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";
const demo = JSON.parse(readFileSync(join(ROOT, "demo.json"), "utf8"));

const readJsonl = (file) =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .flatMap((l) => {
          try {
            return [JSON.parse(l)];
          } catch {
            return [];
          }
        })
    : [];

// USDC balanceOf via plain JSON-RPC, cached so polling doesn't hammer the RPC.
let balances = { at: 0, value: {} };
async function usdcBalance(address) {
  const data = "0x70a08231" + address.slice(2).toLowerCase().padStart(64, "0");
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: demo.usdc, data }, "latest"] }),
  });
  const { result } = await res.json();
  return Number(BigInt(result ?? "0x0")) / 1e6;
}
async function getBalances() {
  if (Date.now() - balances.at < 8_000) return balances.value;
  try {
    const [seller, buyer] = await Promise.all([usdcBalance(demo.seller.address), usdcBalance(demo.buyer.address)]);
    balances = { at: Date.now(), value: { seller, buyer } };
  } catch (e) {
    balances.value.error = e.message;
  }
  return balances.value;
}

let catalog = null;
async function getCatalog() {
  try {
    catalog = await (await fetch(`${demo.seller.url}/catalog`, { signal: AbortSignal.timeout(10000) })).json();
    catalog.online = true;
  } catch {
    if (catalog) catalog.online = false;
  }
  return catalog ?? { online: false, conferences: [] };
}

const app = express();
app.get("/", (_req, res) => res.sendFile(join(HERE, "index.html")));
app.get("/api/state", async (_req, res) => {
  const [cat, bal] = await Promise.all([getCatalog(), getBalances()]);
  res.json({
    demo,
    catalog: cat,
    balances: bal,
    events: readJsonl(join(ROOT, "events.jsonl")).slice(-200),
    sales: readJsonl(join(ROOT, "seller", "sales.log")).slice(-200),
  });
});
app.listen(PORT, () => console.log(`Dashboard on http://localhost:${PORT}`));
