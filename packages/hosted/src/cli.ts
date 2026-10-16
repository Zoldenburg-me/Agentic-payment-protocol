import { openSqlite } from '@zold/accept/sqlite';
import { MerchantStore } from './merchants.js';

// shortcut: operator-run until merchant signup with a passkey Safe (merchant-safes phases 2-3) replaces it; no audit trail yet.
const USAGE = `usage (HUB_DB_PATH set):
  add <merchant-id> <payTo>   prints the new zsk_ key once
  rotate <merchant-id>        prints a new key; the old one stops working
  revoke <merchant-id>
  list`;

const [command, id, payTo] = process.argv.slice(2);
const dbPath = process.env.HUB_DB_PATH;
if (dbPath === undefined || command === undefined) {
  console.error(USAGE);
  process.exit(2);
}
process.umask(0o077);
const db = openSqlite(dbPath);
const merchants = new MerchantStore(db);
try {
  if (command === 'add' && id !== undefined && payTo !== undefined) console.log(merchants.add(id, payTo));
  else if (command === 'rotate' && id !== undefined) console.log(merchants.rotate(id));
  else if (command === 'revoke' && id !== undefined) merchants.revoke(id);
  else if (command === 'list') for (const m of merchants.all()) console.log(`${m.id}\t${m.payTo}${m.revoked ? '\trevoked' : ''}`);
  else {
    console.error(USAGE);
    process.exitCode = 2;
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  db.close();
}
