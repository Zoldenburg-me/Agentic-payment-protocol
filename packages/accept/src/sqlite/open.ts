import { DatabaseSync } from 'node:sqlite';
import { AcceptError, AcceptErrorCode as E } from '../errors.js';

/** How long a write waits for another process's write lock before failing. */
const BUSY_TIMEOUT_MS = 5000;

/**
 * Opens (or creates) the database file the SQLite stores share. WAL lets several processes on one
 * host read while one writes; each store creates its own table. Pass `:memory:` for tests.
 */
export function openSqlite(path: string): DatabaseSync {
  if (path.trim() === '') throw new AcceptError(E.CONFIG_INVALID, 'the SQLite path is empty');
  const db = new DatabaseSync(path);
  // busy_timeout first: switching a new file to WAL takes a lock, and workers starting together would fail at once.
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}; PRAGMA journal_mode = WAL;`);
    return db;
  } catch (error) {
    db.close(); // a startup retry loop must not pile up open handles
    throw error;
  }
}
