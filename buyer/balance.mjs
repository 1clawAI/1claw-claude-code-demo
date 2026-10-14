// This agent's Base address and USDC balance, read straight from Base.
//
//   node balance.mjs
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, agentClient, baseAddress, usdcBalance } from "../shared/oneclaw.mjs";

loadEnv(dirname(fileURLToPath(import.meta.url)));
const address = await baseAddress(agentClient(), process.env.ONECLAW_AGENT_ID);
console.log(JSON.stringify({ address, usdc: await usdcBalance(address), basescan: `https://basescan.org/address/${address}` }));
