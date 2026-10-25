#!/bin/sh
# Encrypts one hub DB snapshot with age and uploads it to an S3-compatible bucket (Cloudflare R2).
# Usage: offsite-backup.sh <snapshot.db>
# Env: AGE_RECIPIENT (age public key; its private key never lives on this host), AGE (path to age, default: age),
#      R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY (a token that can only write that bucket).
set -eu
src=${1:?usage: offsite-backup.sh <snapshot.db>}
: "${AGE_RECIPIENT:?}" "${R2_ENDPOINT:?}" "${R2_BUCKET:?}" "${R2_ACCESS_KEY_ID:?}" "${R2_SECRET_ACCESS_KEY:?}"
# age happily encrypts an empty or broken file: check first (-s before sqlite3, which creates a missing file),
# including that it is the hub's database and not a fresh one made from a wrong path.
check="PRAGMA integrity_check; SELECT 'tables' FROM seller_payments, merchants LIMIT 0"
[ -s "$src" ] && out=$(sqlite3 -readonly "$src" "$check") && [ "$out" = ok ] || { echo "bad snapshot: $src" >&2; exit 1; }
enc=$(mktemp)
trap 'rm -f "$enc"' EXIT
trap 'exit 1' HUP INT TERM
"${AGE:-age}" -r "$AGE_RECIPIENT" -o "$enc" -- "$src"
# Time in the key: a locked bucket refuses to overwrite an object, so a second run on one day must not reuse a name.
key="hub-$(date -u +%Y%m%d-%H%M%S).db.age"
# Credentials go in on stdin, not argv, where any local user could read them with ps.
printf 'user = "%s:%s"\n' "$R2_ACCESS_KEY_ID" "$R2_SECRET_ACCESS_KEY" |
  curl -q -fsS -K - --proto =https --connect-timeout 30 --max-time 1800 --retry 3 \
    --aws-sigv4 "aws:amz:auto:s3" -T "$enc" "$R2_ENDPOINT/$R2_BUCKET/$key"
echo "$(date -u +%FT%TZ) uploaded $key"
