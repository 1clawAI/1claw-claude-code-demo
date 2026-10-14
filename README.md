# Agents trading data: two Claude Code agents, 1Claw, and x402 on Base

Two Claude Code sessions run as two separate companies:

| | **LeadForge** (`seller/`) | **Pipeline** (`buyer/`) |
|---|---|---|
| Job | Sells conference attendee lead lists, $0.01 per lead | An SDR agent that buys leads for outbound |
| 1Claw agent | `leadforge-seller` | `pipeline-buyer` |
| 1Claw vault | `leadforge-seller`: `leads/*` inventory, `sales/*` receipts, `cdp/*` facilitator creds | `pipeline-buyer`: `purchased/*` lists |
| Base key (HSM) | `payTo` address, receive-only (`tx_max_value = 0`) | x402 payer, capped by 1Claw pay guardrails |
| Talks x402 via | `@x402/express` v2 + Coinbase CDP facilitator | `1Claw pay.prepare` → `pay.sign` (`buyer/buy.mjs`) |

Payments are **real USDC on Base mainnet** (`eip155:8453`). A typical demo spends well under $1.

```
 Pipeline (Claude Code)                                    LeadForge (Claude Code)
 ──────────────────────                                    ───────────────────────
 discover.mjs ─── 1Claw agent directory ──────────────────► listed: "conference leads"
             └─── GET /catalog (free) ────────────────────► server.mjs  ◄── vault leads/*
 buy.mjs ──────── GET /leads/kubecon…?title=sre ─────────► 402 PAYMENT-REQUIRED ($0.0N)
    │  raw 402 bytes
    ▼
 1Claw pay.prepare ── checks: ≤$0.50/payment, ≤$3/day, payTo ∈ {LeadForge}
 1Claw pay.sign ───── HSM signs EIP-3009 USDC transfer; key never leaves 1Claw
    │  PAYMENT-SIGNATURE
    ▼
 GET /leads/… (paid) ─────────────────────────────────────► CDP facilitator verifies and settles on Base
 ◄────────────────────────────── leads JSON + PAYMENT-RESPONSE (tx hash)
 saved → vault pipeline-buyer/purchased/*                    receipt → vault leadforge-seller/sales/*
```

## What 1Claw does in this demo

- **Identity**: each Claude Code session runs as its own 1Claw agent, with its own `ocv_` key and its own MCP server. Neither session can read the other's vault.
- **Vaults**: the seller's inventory and Coinbase API keys sit in the HSM-backed vault, not on disk. Purchased data lands in the buyer's vault.
- **Keys**: both wallets are 1Claw signing keys. No private key exists in either project.
- **x402 pay guardrails**: a human sets per-payment and daily caps and a pay-to allowlist, and the agent cannot change them. Every payment is checked by the vault before it is signed.
- **Directory**: the seller is discoverable, and the buyer finds it through `discovery.orgDirectory` / `directory`.
- **Inspect**: the buyer runs `inspect_content` on purchased data, because a seller's payload is untrusted input.

## Setup (about 10 minutes, once)

You need Node ≥ 22, Claude Code, a 1Claw account, and a Coinbase Developer Platform API key (the mainnet facilitator requires one: portal.cdp.coinbase.com → API keys).

```bash
npm install
cp .env.human.example .env.human     # fill in ONECLAW_API_KEY (1ck_…), ONECLAW_PASSWORD, CDP_API_KEY_ID/SECRET
npm run bootstrap                    # vaults, agents, policies, Base keys, pay guardrails, directory listing
```

Bootstrap prints the **buyer's Base address**. Send it about $2 of USDC on Base. It needs no ETH, because the facilitator pays gas.

Then stock the seller's shelves (or let the seller agent do it on first run):

```bash
npm run seller:stock
```

`.env.human` is used only by bootstrap. Each agent gets only its own `seller/.env` or `buyer/.env`, and `run-*.sh` loads only that one file.

## Running the demo

Start the dashboard (optional, but it's the best view for an audience):

```bash
npm run dashboard   # http://localhost:4020
```

It is a read-only observer with no 1Claw credentials. It shows both agents' live USDC balances (read from Base), the catalog, every quote, approval, denial and settlement as it happens, and how much of the buyer's daily limit has been spent.

Then open two terminals side by side:

```bash
./run-seller.sh     # Terminal A: LeadForge opens its store
./run-buyer.sh      # Terminal B: Pipeline shops for leads
```

Each agent follows the opening checklist in its `CLAUDE.md`.

1. **LeadForge** shows its `payTo` address and balance, checks inventory in the vault, starts `server.mjs`, and prints the catalog.
2. **Pipeline** shows its wallet, finds LeadForge in the 1Claw directory, reads the catalog, and plans 2–3 small buys (about $0.60) against platform and infra titles at KubeCon and re:Invent, plus one deliberately oversized request.
3. Pipeline buys everything in one `buy.mjs` call, in parallel. The small lists settle on Base with basescan links. 1Claw refuses the oversized one at `prepare` (over the $0.50 cap), and nothing is signed.
4. Ask LeadForge *"any sales?"*. It tails the sales log, links the tx, and re-checks its USDC balance.
5. Pipeline dedupes the lists and presents the top 10 leads with openers.

### Moments worth showing

- **Guardrail denial.** Ask Pipeline to *"buy every re:Invent lead, no --max-usd"* (80 leads = $0.80, over the $0.50 cap). 1Claw returns `deny` at `prepare`, and nothing is signed.
- **Allowlist.** Change `PRICE_PER_LEAD_USD`, or point the buyer at any other x402 endpoint. Any payTo that isn't LeadForge is refused by the vault, not by the agent.
- **No keys anywhere.** `grep -r "PRIVATE" .` finds nothing. Show the two agents and their keys in the 1Claw dashboard.
- **Human in the loop.** Re-run bootstrap with `pay_require_approval: true` (in `setup/bootstrap.mjs`). The buyer's `prepare` then returns an approval requirement, and you approve the payment from your phone.

## Files

```
setup/bootstrap.mjs   human-run provisioning via @1claw/sdk
shared/oneclaw.mjs    client + helpers (network = Base mainnet)
seller/server.mjs     x402 v2 storefront (express + @x402/express + @coinbase/x402)
seller/stock.mjs      writes synthetic lead lists into the seller vault
seller/CLAUDE.md      LeadForge persona and checklist
buyer/discover.mjs    1Claw directory search + free catalog
buyer/buy.mjs         x402 client: 402 → 1Claw pay.prepare/sign → paid retry → vault
buyer/CLAUDE.md       Pipeline persona, budget and checklist
*/.mcp.json           1Claw MCP server, bound to that directory's agent key
*/.claude/settings.json  tool allowlist; each agent is denied the other's directory
```

All leads are **synthetic** (`synthetic: true`, `*.example.com`). The conference names are real events, but no real attendee data is involved.
