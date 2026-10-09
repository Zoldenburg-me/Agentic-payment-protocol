import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { ProtocolId } from './types.js';

export type LedgerStatus = 'reserved' | 'paid' | 'unconfirmed' | 'released';

export interface LedgerEntry {
  readonly id: string;
  readonly at: string;
  readonly url: string;
  readonly protocol: ProtocolId;
  readonly usdMicros: string;
  readonly status: LedgerStatus;
  readonly reference?: string;
}

const STATUSES: readonly string[] = ['reserved', 'paid', 'unconfirmed', 'released'];

function parseEntry(line: string): LedgerEntry | undefined {
  try {
    const e = JSON.parse(line) as Partial<LedgerEntry>;
    const valid =
      typeof e.id === 'string' && typeof e.at === 'string' && !Number.isNaN(Date.parse(e.at)) &&
      typeof e.url === 'string' && typeof e.protocol === 'string' &&
      typeof e.usdMicros === 'string' && /^\d+$/.test(e.usdMicros) &&
      typeof e.status === 'string' && STATUSES.includes(e.status);
    return valid ? (e as LedgerEntry) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Spend ledger. One process per ledger file: the budget is not shared across processes. Every state change appends a full record (JSONL when a path is given),
 * and the last record per id wins on load, so the daily budget survives restarts.
 * Anything not explicitly `released` counts as spent: failing closed beats overspending.
 */
export class Ledger {
  private byId = new Map<string, LedgerEntry>();

  constructor(private readonly path?: string) {
    if (path && !existsSync(path)) writeFileSync(path, '', { mode: 0o600 });
    if (path && existsSync(path)) {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const entry = parseEntry(line);
        // A torn write (crash) or tampered line is skipped, never allowed to block startup
        // or to lower the recorded spend.
        if (entry) this.byId.set(entry.id, entry);
      }
    }
  }

  spentToday(now: Date = new Date()): bigint {
    const day = now.toISOString().slice(0, 10);
    let total = 0n;
    for (const e of this.byId.values()) {
      if (e.status !== 'released' && e.at.slice(0, 10) === day) total += BigInt(e.usdMicros);
    }
    return total;
  }

  reserve(url: string, protocol: ProtocolId, usdMicros: bigint, now: Date = new Date()): string {
    const entry: LedgerEntry = {
      id: randomUUID(), at: now.toISOString(), url, protocol,
      usdMicros: usdMicros.toString(), status: 'reserved',
    };
    this.write(entry);
    return entry.id;
  }

  settle(id: string, status: Exclude<LedgerStatus, 'reserved'>, reference?: string): void {
    const current = this.byId.get(id);
    if (!current) throw new Error(`unknown ledger entry ${id}`);
    this.write({ ...current, status, ...(reference ? { reference } : {}) });
  }

  entries(): readonly LedgerEntry[] {
    return [...this.byId.values()];
  }

  private write(entry: LedgerEntry): void {
    this.byId.set(entry.id, entry);
    if (this.path) appendFileSync(this.path, JSON.stringify(entry) + '\n');
  }
}
