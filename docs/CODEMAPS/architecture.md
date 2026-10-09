<!-- Generated: 2026-10-08 | Files scanned: 18 (1401 lines) | Token estimate: ~900 -->
# agentpay-hub Architecture

Single TypeScript library + MCP server. No database, no frontend. Entry points:
`src/index.ts` (library), `src/mcp/server.ts` (stdio MCP), `examples/demo.ts`.

## Mental model (one sentence per layer)
- **Hub** asks a URL; on HTTP 402 it asks every **Adapter** "can you read this offer?"
- Each readable offer becomes a protocol-neutral **Quote** (payee, amount, asset, network).
- **Policy** judges each Quote in micro-USD (per-tx cap, daily budget, host, protocol, known asset).
- Hub picks the **cheapest payable** Quote (ties: policy.preference), reserves it in the **Ledger**,
  asks the Adapter to **authorize** (sign via the **Wallet**), replays the request once, reads the receipt.

## Request flow (src/hub.ts: PaymentHub.request)
```
request(url, init, mode)
  send (redirect:manual, 15s timeout) ── not 402 ──► {free}
  402 ─► adapters.parseQuotes (errors swallowed per adapter) ─► none ─► {unsupported}
  ─► evaluate(quote) per quote  +  adapter.canPay(wallet)
  mode=quote ──► {quoted}
  choose cheapest ok+payable ─► none ─► {blocked}
  ledger.reserve (same tick as check: no race)
  adapter.authorize ── throws ─► ledger released, rethrow
  send again with payment headers (agent copies of payment headers stripped)
    ├─ 402 again ─► ledger 'unconfirmed' (stays counted) ─► {rejected}
    ├─ ok        ─► ledger 'paid' (+receipt ref)       ─► {paid}
    └─ other     ─► ledger 'unconfirmed'               ─► {paid-but-not-ok}
```

## Module map
```
types.ts        Quote, Money, Wallet, ProtocolAdapter, X402/MPP signer interfaces   (87)
hub.ts          PaymentHub: orchestration, choose(), mergeHeaders()                  (170)
policy.ts       Policy, DEFAULT_POLICY ($0.10/tx, $1/day), evaluate() → Verdict      (55)
assets.ts       stablecoin registry (network:asset → decimals), toUsdMicros (ceil)   (35)
ledger.ts       JSONL spend log; reserve/settle/spentToday; validates on load        (86)
adapters/x402.ts  PAYMENT-REQUIRED → quotes; builds PAYMENT-SIGNATURE; PAYMENT-RESPONSE (86)
adapters/mpp.ts   WWW-Authenticate: Payment → quotes; builds Authorization/Payment-Authorization (88)
adapters/index.ts DEFAULT_ADAPTERS [x402, mpp]; UNSUPPORTED_PROTOCOLS list           (19)
wallets/evm.ts  EIP-3009 TransferWithAuthorization signer (viem), ≤300s validity     (75)
wallets/mock.ts fake MPP signer (moves no funds)                                     (14)
config.ts       hubFromEnv(): AGENTPAY_* env → wallet+policy+ledger                  (50)
net-guard.ts    assertPublicHttps, isNonPublicIp, readCapped, redactUrl              (63)
mcp/server.ts   tools payment_quote(GET only) / payment_fetch / payment_status       (133)
testing/mock-merchant.ts  local server speaking x402+MPP, verifies EIP-712 sigs      (142)
```

## Trust boundaries
- **Untrusted:** every byte of a 402 response (headers, amounts, timeouts, header names).
- **Trusted:** policy, ledger, wallet, env config.
- MCP callers (agents) are semi-trusted: URL guarded (https, public IP, allowlist required to pay).

## Not built
ACP, AP2, UCP, Visa TAP, Mastercard Agent Pay, L402; real MPP signer; x402 v1;
smart-account/session-key wallet; merchant side.
