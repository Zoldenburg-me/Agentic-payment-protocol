import { redactUrls } from '@zold/accept';

export { redactUrls };

/** One JSON line: name, code and short message, URLs redacted. The cause is left out (viem nests the RPC URL there). */
export function errorLine(error: unknown): string {
  const e = error as { name?: unknown; code?: unknown; shortMessage?: unknown; message?: unknown } | undefined;
  const message = redactUrls(String(e?.shortMessage ?? e?.message ?? error));
  return JSON.stringify({ level: 'error', name: redactUrls(String(e?.name)), code: e?.code, message });
}
