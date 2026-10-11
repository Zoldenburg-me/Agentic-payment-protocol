# agentpay-hub

One interface for agent payment protocols. Point an agent at any paid URL; the hub works out
which protocol the server speaks, checks your spend limits, pays, and returns the content.

```
agent ──► payment_fetch(url) ──► PaymentHub ──► 402? ─► adapters parse quotes (x402, MPP, …)
                                                 │         │
                                                 │   spend policy (per-tx cap, daily budget,
                                                 │   host/protocol allowlist, known stablecoins)
                                                 │         │
                                                 └── cheapest payable quote ─► sign ─► retry ─► content + receipt
```

## Status

| Protocol | Layer | Status |
|---|---|---|
| **x402 v2** (Coinbase / x402 Foundation) | per-request HTTP 402, stablecoin | ✅ `exact` scheme on EVM (EIP-3009). **Verified once on Base Sepolia** (2026-10-08): one $0.01 test-USDC payment to Coinbase's demo endpoint settled on-chain. Not tested on mainnet, other servers, or other facilitators. |
| **MPP** (Stripe + Tempo) | per-request HTTP 402, stablecoin/card/Lightning | ⚠️ `charge` intent parsed and credential built; **signer is a mock** (see below) |
| ACP (OpenAI + Stripe) | merchant checkout | ❌ not an HTTP paywall; needs Stripe Shared Payment Tokens |
| AP2 (Google) | signed-mandate authorization | ❌ needs a credentials provider |
| UCP (Google + Shopify) | shopping journey | ❌ delegates payment to AP2 |
| Visa TAP / Mastercard Agent Pay | card-network agent tokens | ❌ needs network enrolment |

The unsupported ones are different *layers* (checkout, authorization, card tokens), not paywalls,
so they cannot be auto-detected from a 402 and need onboarding with the respective provider.
`payment_status` lists them so an agent knows what is missing.

Tested two ways. A local mock merchant (`src/testing/mock-merchant.ts`) verifies real EIP-712
signatures for x402 and echoes MPP challenge ids. And one live x402 payment (1 cent of Base Sepolia
test USDC, `https://x402.vercel.app/protected`) settled on-chain with a matching Transfer event.
**Not yet tested on mainnet, with real funds, or against Tempo / MPP live.** Wire formats were taken from the x402 v2 spec and mpp.dev docs; MPP's
receipt format is not documented, so receipt parsing is best-effort.

## Use

```bash
npm install
npm test          # 24 tests
npm run demo      # runs the hub against the mock merchant
```

### As an MCP server (works with any MCP-capable agent)

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

Tools: `payment_quote` (price check, never pays), `payment_fetch` (fetch + auto-pay),
`payment_status` (limits, spend, protocols).

With no `AGENTPAY_EVM_PRIVATE_KEY` the server is **quote-only**: it can discover prices but cannot pay.

### As a library

```ts
import { PaymentHub, evmX402Signer } from 'agentpay-hub';
const hub = new PaymentHub({ wallet: { x402: evmX402Signer(key) } });
const r = await hub.request('https://api.example.com/data');   // 'pay' mode
if (r.status === 'paid') console.log(await r.response.text(), r.receipt);
```

## Safety model

- Default caps: **$0.10 per call, $1.00 per day**. Only registered USD stablecoins are payable
  (USDC on Base / Base Sepolia by default); anything else is refused. Extend via `withAssets`.
- Budget is reserved *before* signing, and anything not explicitly released counts as spent.
  The JSONL ledger makes the daily budget survive restarts.
- Use a **dedicated hot wallet with a small balance**.
- Over MCP, `payment_fetch` is **disabled until `AGENTPAY_ALLOWED_HOSTS` is set**, only `https://` URLs
  are accepted, and hosts resolving to private/loopback/link-local addresses are refused.
  `payment_quote` is GET-only so a price check has no side effects.
- Redirects are never followed (payment is bound to the exact URL), requests time out after 15 s, and
  response bodies are read with a hard cap.
- x402 signatures are valid for at most 5 minutes regardless of what the server asks for, and malformed
  offers are dropped. A 402 reply *after* signing keeps the amount counted until the day rolls over,
  because the server holds a signed authorization it could still settle.
- One process per ledger file: the budget is not shared across processes.
- Known limit: the private-address check resolves DNS before fetching, so DNS rebinding is only
  fully covered by the host allowlist.

## Adding a protocol

Implement `ProtocolAdapter` (`src/types.ts`): `parseQuotes`, `canPay`, `authorize`, `parseReceipt`,
add it to `DEFAULT_ADAPTERS`, and add a signer capability to `Wallet`.

## To do for real use

1. A real MPP signer (submit the Tempo transfer / Stripe SPT and return the proof).
2. Test x402 against a live facilitator on Base Sepolia.
3. x402 v1 (`X-PAYMENT` header, body-encoded requirements) for older servers.
4. ACP / AP2 adapters once you have provider credentials to test against.

---

All rights reserved.
