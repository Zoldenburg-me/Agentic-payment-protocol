# @zold/hosted

The hub's hosted settlement: `POST /api/agent-payments/settle`, the route `zoldSeller` calls. A hosted
seller holds only a `zsk_` key. The hub verifies, relays `transferWithAuthorization` from its gas-only
key and keeps the ledger. USDC moves straight from the payer to the merchant's own address.

**Base Sepolia only** (Circle USDC `0x036C…CF7e`). The chain is fixed in `src/main.ts`.

## Run

```bash
npm run build
export HUB_DB_PATH=/var/lib/zold-hub/hub.db   # created mode 0600
export HUB_RPC_URL=https://…                   # your Base Sepolia RPC (https, or http to localhost)
export HUB_RELAY_KEY=0x…                       # gas-only: fund it with Sepolia ETH, nothing else; no other process may use it
export HUB_TRUSTED_PROXY_HOPS=1                # behind one reverse proxy; 0 if clients connect directly
node packages/hosted/dist/cli.js add shareme 0xMerchantAddress   # prints the zsk_ key once
node packages/hosted/dist/main.js                                # listens on 127.0.0.1:8787
```

Put it behind TLS on the hub's domain. The seller sets `zoldSeller({ apiUrl: 'https://<hub domain>', apiKey })`.

| Variable | Default | |
|---|---|---|
| `HUB_HOST`, `HUB_PORT` | `127.0.0.1`, `8787` | |
| `HUB_TRUSTED_PROXY_HOPS` | required | proxies in front (1 behind one reverse proxy), for the failed-key limit per IP |
| `HUB_MIN_AMOUNT` | `1000` ($0.001) | smallest price settled, atomic USDC |
| `HUB_PER_MINUTE` | `600` | settle calls per seller key per minute |
| `HUB_PAID_PER_DAY` | `2000` | calls carrying a payment per seller key per 24 h |
| `HUB_PAID_PER_DAY_TOTAL` | `20000` | the same over all keys: caps the relay's gas |
| `HUB_FAILED_KEYS_PER_MINUTE` | `20` | bad keys per IP per minute before that IP is refused |

Merchants: `cli.js add | rotate | revoke | list`. Run it on the host, against the same `HUB_DB_PATH`.

## Not yet (merchant-safes plan)

- Signup with a passkey and a hub-made Safe: today the operator enters the payee address.
- Key self-service with passkey step-up, and an audit trail.
- `listOpen()` and retention pruning.
- A dashboard and withdrawals.
- One host only: SQLite.
