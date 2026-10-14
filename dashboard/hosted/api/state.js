// Hosted /api/state. Vercel can't see the laptop running the agents, so this
// serves a snapshot (catalog + the 1Claw quote/allow/deny/paid feed) taken by
// `npm run dashboard:deploy`, with both agents' USDC balances read live from Base.
import snapshot from "../snapshot.json" with { type: "json" };

const RPC = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";
const { demo } = snapshot;

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

let balances = { at: 0, value: {} };
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

export default async function handler(_req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.json({ hosted: true, taken_at: snapshot.taken_at, demo, catalog: snapshot.catalog, balances: await getBalances(), events: snapshot.events, sales: [] });
}
