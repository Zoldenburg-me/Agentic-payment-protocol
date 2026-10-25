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
| `HUB_RETENTION_YEARS` | `10` (minimum) | finished payments are deleted after the end of their calendar year plus this many years (§ 147 AO), at startup and daily |

Merchants: `cli.js add | rotate | revoke | list`. Run it on the host, against the same `HUB_DB_PATH`.

## Settled payments

`GET /api/agent-payments/settled?since=<seq>&limit=<n>` with the merchant's `Authorization: Bearer zsk_…` lists that
merchant's settled payments with `seq > since` (default 0), in the order they settled, `limit` 1–500 (default 100). It only reads.

```json
{ "payments": [{ "seq": 7, "claim_key": "…", "txHash": "0x…", "logIndex": 1, "amount": "1000", "chainId": 84532,
  "asset": "0x036C…CF7e", "payTo": "0xMerchant…", "payer": "0xBuyer…" }], "next_since": 7 }
```

- `seq` is the ledger's `settled_seq`, numbered when a payment settles, so a payment that settles after a later one is still
  listed past your cursor. Pass `next_since` as the next `since`; an empty page returns `since` unchanged.
- `logIndex` is the payment's USDC `Transfer` log in `txHash`, read from the receipt at settlement; `(txHash, logIndex)`
  names one transfer. Payments settled before it was stored have `null`.
- `amount` is atomic USDC as a string. Owed, submitted and refused payments are not listed. The ledger stores no settlement
  time: take it from the transaction's block.
- A key only ever reads its own merchant's rows: an optional `merchant=<payTo>` that is not the key's payee is 403. A bad key
  is 401 and counts toward the per-IP lockout; reads per key are limited to `HUB_PER_MINUTE`, apart from settle calls.

On the first start after this change the hub adds `settled_seq` to an existing database and numbers the already-settled
payments in `seq` order, in one transaction; a restart never renumbers them.

## Backups

The database holds payers' addresses and must outlive the host, so snapshot it nightly and copy it off the machine encrypted:

```sh
umask 077                                                    # the snapshot holds payers' addresses
f=/backups/hub-$(date +%Y%m%d).db
sqlite3 -cmd '.timeout 5000' "$HUB_DB_PATH" ".backup $f" &&  # consistent while the hub runs
packages/hosted/scripts/offsite-backup.sh "$f" >> /backups/backup.log 2>&1 &&
find /backups -name 'hub-*.db' -mtime +14 -delete            # only after an upload: local copies keep pruned rows too
```

The script encrypts with [age](https://age-encryption.org) to `AGE_RECIPIENT` and uploads with `curl --aws-sigv4`. Give it a token that can only write the one bucket, and keep the age private key off the host (a password manager). Let the bucket expire old objects, since a backup keeps rows the hub has pruned; a bucket lock keeps a compromised host from deleting recent ones.

Restore, on a machine that holds the private key. Make a short-lived token that can only read the bucket; `read -rs` (bash, zsh) keeps its secret out of shell history:

```sh
cf r2 objects list --bucket-name <bucket> --cf-r2-jurisdiction eu       # names the objects; or download one in the dashboard
umask 077                                                    # hub.db is plaintext
read -r id; read -rs secret
printf 'user = "%s:%s"\n' "$id" "$secret" | curl -fsS -K - --aws-sigv4 aws:amz:auto:s3 -o hub.db.age \
  "https://<account id>.eu.r2.cloudflarestorage.com/<bucket>/hub-YYYYMMDD-HHMMSS.db.age" &&
age -d -i <key file> -o hub.db hub.db.age &&
[ -s hub.db ] && [ "$(sqlite3 hub.db 'PRAGMA integrity_check')" = ok ] &&
sqlite3 hub.db 'SELECT COUNT(*) FROM seller_payments; SELECT COUNT(*) FROM merchants'
```

The counts you expect, else stop. Stop the hub, delete `$HUB_DB_PATH-wal` and `$HUB_DB_PATH-shm` (the ledger runs in WAL mode; a stale log would be applied to the restored file), put `hub.db` at `HUB_DB_PATH` (mode 0600, the hub's user), start it. Whatever the hub recorded after the snapshot is gone from the ledger; the transfers themselves are still on chain. Do one restore with the real key after setting this up: a wrong recipient makes every backup unreadable.

## Not yet (merchant-safes plan)

- Signup with a passkey and a hub-made Safe: today the operator enters the payee address.
- Key self-service with passkey step-up, and an audit trail.
- `listOpen()`.
- A dashboard and withdrawals.
- One host only: SQLite.
