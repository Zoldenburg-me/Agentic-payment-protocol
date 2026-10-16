# Zold: accept AI agents as customers

Buyer agents can already browse, compare and pay. Most businesses can't take their money. Zold is the
seller side: a few lines in your server, and an agent that hits a paid route gets a price, pays, and
gets the result, with no checkout page, no account and no human in the loop.

```
agent ──► GET /report ──► your server + @zold/accept
                              │
                              ├─ no payment?  ─► 402 + price (x402 offer)
                              │
                              └─ payment?     ─► verify signature ─► claim once ─► settle on-chain
                                                   ─► your route runs ─► 200 + receipt
```

## Status

What works today, and what doesn't yet:

| | Status |
|---|---|
| **x402 v2 acceptance** (`@zold/accept`) | ✅ Verify EIP-3009 authorizations, claim each payment once, settle `transferWithAuthorization` yourself (no facilitator), deliver once. USDC on Base and Base Sepolia. |
| **Hosted settlement** (`zoldSeller`) | ✅ Price on your server; Zold verifies, settles to your own Safe, and keeps the ledger. You hold a `zsk_…` seller key, not a hot wallet. |
| Server adapters | ✅ `node:http`, Express 4/5 |
| **Live chain** | ⚠️ Seller side tested against an in-memory USDC and a scripted JSON-RPC, **not yet against a live chain**. |
| MPP (Stripe + Tempo) | ❌ Seller side not started |
| ACP (OpenAI + Stripe), UCP (Google + Shopify), AP2 (Google) | ❌ Planned: these are checkout and authorization flows, not per-request paywalls |
| Visa TAP / Mastercard Agent Pay | ❌ Need network enrolment |

Today this fits anything you can sell per HTTP request: APIs, data, reports, files, compute. Orders,
bookings and leads need the checkout protocols in the last rows; that is the roadmap.

## Accept agent payments

### Hosted: no wallet to run

```ts
import express from 'express';
import { zoldSeller, expressPayment, expressDeliveryErrors, paymentOf } from '@zold/accept';

const seller = zoldSeller({
  apiUrl: process.env.ZOLD_API_URL!,      // the Zold API origin
  apiKey: process.env.ZOLD_SELLER_KEY!,   // zsk_…, keep it in env
  price: () => ({ amount: 10_000n }),     // $0.01 in USDC atomic units (6 decimals)
  onError: (e) => console.error(e),
});

const app = express();
app.get('/report', expressPayment(seller), (req, res) => {
  const paid = paymentOf(res)!;           // payer, amount, txHash, claimKey, …
  res.json({ report: '…', paidBy: paid.payer });
});
app.use(expressDeliveryErrors(seller));
app.listen(3000);
```

If Zold can't be reached, nothing is delivered and the agent gets a 503 it can retry.

### Self-hosted: you settle on your own RPC

```ts
import { createServer } from 'node:http';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { MemorySingleUseStore } from 'agentpay-hub/protocol';
import { accept, nodeHandler, viemChain, viemSubmitter, MemorySellerLedger } from '@zold/accept';

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const payTo = '0xYourTreasury…';
const client = createPublicClient({ chain: base, transport: http(process.env.RPC_URL) });
const wallet = createWalletClient({
  chain: base, transport: http(process.env.RPC_URL),
  account: privateKeyToAccount(process.env.GAS_KEY as `0x${string}`), // holds ETH for gas only
});

const acceptor = accept(
  { sellerAccountId: 'my-shop', payTo, chainId: 8453, asset: USDC, price: () => ({ amount: 10_000n }) },
  {
    ledger: new MemorySellerLedger(),       // dev only: see SQLite below
    claims: new MemorySingleUseStore(),
    chain: viemChain({ client, chainId: 8453 }),
    submitter: viemSubmitter({ wallet, client, chainId: 8453, asset: USDC, payTo, maxGas: 150_000n, maxFeePerGas: 10_000_000_000n }),
    onError: (e) => console.error(e),
  },
);

createServer(nodeHandler(acceptor, (req, res, paid) => { res.end('the paid content'); })).listen(3000);
setInterval(() => acceptor.reconcileOwed(), 60_000); // settle or expire payments left open
```

The gas key can only call `transferWithAuthorization` on the pinned token, to the pinned payee. Funds go
straight from the agent to `payTo`; they never pass through the server.

For production, swap the in-memory stores for SQLite. One database file backs all three:

```ts
import { openSqlite, SqliteSellerLedger, SqliteSingleUseStore, SqliteRateLimiter } from '@zold/accept/sqlite';

const db = openSqlite('./seller.db');
// pass these to accept() in place of the memory stores above
const stores = { ledger: new SqliteSellerLedger(db), claims: new SqliteSingleUseStore(db), rateLimiter: new SqliteRateLimiter(db) };
```

WAL mode lets several processes on one host share the file. Use local disk, not a network filesystem.
Needs Node >= 22.13 (`node:sqlite`). The `reconcileOwed()` timer above also prunes expired claims; a full
claims store refuses new payments rather than forget one.

### How a payment is handled

- **Price is header-only and deterministic.** `price` sees method, path and headers, never the body,
  and must return the same price for the same request so a retry is delivered, not charged twice.
- **Each payment is delivered once.** Payments are claimed by authorization nonce. A retry of a payment
  that was already delivered comes back with `paid.replayed = true`: serve the same resource again,
  keyed by `paid.claimKey`, and repeat no side effects.
- **Settle, then deliver.** By default the route runs only after the transfer has 2 confirmations.
  `optimistic` delivery (GET/HEAD only, up to $0.50) is opt-in.
- **Built-in limits.** Per-IP and per-payer rate limits, a cap on settlements in flight (503 BUSY
  beyond it), and a 4-minute maximum offer validity.
- **Strict config.** Unknown options, out-of-range numbers and tokens without a pinned EIP-712 domain
  are errors, never silent defaults.

## The buyer side: `agentpay-hub`

This repo also contains the agent-side client the seller package is built on. One interface for paying
any agent paywall: point an agent at a URL, the hub works out which protocol the server speaks, checks
spend limits, pays, and returns the content.

| Protocol | Status |
|---|---|
| **x402 v2** | ✅ `exact` scheme on EVM (EIP-3009). One $0.01 test-USDC payment to Coinbase's demo endpoint settled on Base Sepolia (2026-10-08). Not tested on mainnet, other servers or other facilitators. |
| **MPP** | ⚠️ `charge` intent parsed and credential built; the signer is a mock |
| ACP, AP2, UCP, Visa TAP, Mastercard Agent Pay | ❌ Different layers (checkout, authorization, card tokens); can't be detected from a 402 |

### As an MCP server (any MCP-capable agent)

```json
{
  "mcpServers": {
    "agentpay": {
      "command": "npx",
      "args": ["tsx", "/path/to/agentpay-hub/src/mcp/server.ts"],
      "env": {
        "AGENTPAY_EVM_PRIVATE_KEY": "0x… (a dedicated, low-balance key)",
        "AGENTPAY_MAX_PER_TX_USD": "0.10",
        "AGENTPAY_DAILY_USD": "1.00",
        "AGENTPAY_ALLOWED_HOSTS": "api.example.com",
        "AGENTPAY_LEDGER": "/Users/you/.agentpay-ledger.jsonl"
      }
    }
  }
}
```

Tools: `payment_quote` (price check, never pays), `payment_fetch` (fetch and pay),
`payment_status` (limits, spend, supported protocols). Without `AGENTPAY_EVM_PRIVATE_KEY` the server is
quote-only.

### As a library

```ts
import { PaymentHub, evmX402Signer } from 'agentpay-hub';
const hub = new PaymentHub({ wallet: { x402: evmX402Signer(key) } });
const r = await hub.request('https://api.example.com/data');
if (r.status === 'paid') console.log(await r.response.text(), r.receipt);
```

### Buyer safety model

- Default caps: **$0.10 per call, $1.00 per day**. Only registered USD stablecoins are payable (USDC on
  Base / Base Sepolia by default). Extend via `withAssets`.
- Budget is reserved before signing; anything not explicitly released counts as spent. The JSONL ledger
  keeps the daily budget across restarts. One process per ledger file.
- Over MCP, `payment_fetch` is disabled until `AGENTPAY_ALLOWED_HOSTS` is set; only `https://` URLs are
  accepted, and hosts resolving to private, loopback or link-local addresses are refused. DNS rebinding
  is only fully covered by the host allowlist.
- Redirects are never followed, requests time out after 15 s, and response bodies are size-capped.
- x402 signatures are valid for at most 5 minutes. A 402 after signing keeps the amount counted until
  the day rolls over, since the server holds an authorization it could still settle.
- Use a dedicated hot wallet with a small balance.

To add a protocol, implement `ProtocolAdapter` (`src/types.ts`) and add it to `DEFAULT_ADAPTERS`.

## Develop

```bash
npm install
npm test          # 565 tests, buyer and seller
npm run demo      # the hub paying a local mock merchant
npm run build
npm run pack:private   # dist-pack/: agentpay-hub and @zold/accept tarballs, not published
```

To use the tarballs in another project, vendor both and point npm at them, so it never looks for
`agentpay-hub` on a registry:

```json
"dependencies": { "@zold/accept": "file:vendor/zold-accept-0.1.0.tgz", "agentpay-hub": "file:vendor/agentpay-hub-0.1.0.tgz" },
"overrides": { "agentpay-hub": "file:vendor/agentpay-hub-0.1.0.tgz" }
```

| Path | What it is |
|---|---|
| `packages/accept/` | `@zold/accept`, the seller side |
| `src/protocol/` | Shared wire formats: x402 and MPP codecs, EIP-3009 verification, single-use claims |
| `src/` | `agentpay-hub`, the buyer side, and its MCP server |
| `docs/CODEMAPS/` | Architecture and dependency maps |

## Roadmap

1. Run seller settlement on Base Sepolia, then mainnet.
2. A Postgres `SellerLedgerPort` for sellers running on more than one host (SQLite covers one host).
3. ACP and UCP checkout on the seller side, backed by the merchant's existing Stripe account, so
   agents can place orders and bookings, not just pay per request.
4. MPP acceptance; a real MPP signer on the buyer side.

---

All rights reserved.
