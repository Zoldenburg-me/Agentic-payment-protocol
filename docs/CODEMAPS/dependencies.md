<!-- Generated: 2026-10-08 | Files scanned: 18 (1401 lines) | Token estimate: ~350 -->
# Dependencies

## Runtime (package.json)
- viem ^2        EIP-712 signing (wallets/evm.ts), signature recovery (testing/mock-merchant.ts)
- @modelcontextprotocol/sdk ^1.32  McpServer + stdio transport (mcp/server.ts only)
- zod ^4         MCP tool input schemas (mcp/server.ts only; note z.record needs key+value)

## Dev
- typescript, tsx (runs TS directly: `npm test`, `npm run mcp`, `npm run demo`), @types/node
- Tests use node:test (no test framework dependency)

## Node built-ins used
node:crypto (nonces, ids), node:fs (ledger), node:dns/promises + node:net (net-guard), node:http (mock merchant)

## External services (none called by default)
- Paywalled HTTP servers the agent chooses (x402 v2 / MPP)
- Facilitators/chains are the *server's* concern; this library never calls a facilitator or RPC itself

## Env config (config.ts)
AGENTPAY_EVM_PRIVATE_KEY, AGENTPAY_MAX_PER_TX_USD, AGENTPAY_DAILY_USD,
AGENTPAY_ALLOWED_HOSTS, AGENTPAY_ALLOWED_PROTOCOLS, AGENTPAY_LEDGER

## Dependency direction (no cycles)
types ← assets ← policy ← hub ← config ← mcp/server
types ← adapters ← hub ;  types ← wallets ← config ;  net-guard ← mcp/server
