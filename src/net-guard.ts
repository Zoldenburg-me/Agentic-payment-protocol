import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** True for loopback, private, link-local, CGNAT and other non-public IP literals. */
export function isNonPublicIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a = 0, b = 0] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || a >= 224
    );
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === '::1' || s === '::') return true;
    if (s.startsWith('::ffff:')) return isNonPublicIp(s.slice(7));
    return /^f[cd]/.test(s) || /^fe[89ab]/.test(s);
  }
  return true;
}

/**
 * Reject URLs an agent should never be able to make the hub fetch: non-https, or hosts
 * that resolve to internal addresses. DNS can still change between this check and the
 * fetch (rebinding), so pair it with a host allowlist.
 */
export async function assertPublicHttps(rawUrl: string): Promise<void> {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:') throw new Error('only https:// URLs are allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) throw new Error('localhost is not allowed');
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (addresses.length === 0 || addresses.some((a) => isNonPublicIp(a.address))) {
    throw new Error(`${host} resolves to a non-public address`);
  }
}

/** Read at most `maxChars` of a response body, then cancel the stream. */
export async function readCapped(res: Response, maxChars: number): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: '', truncated: false };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (text.length <= maxChars) {
    const { done, value } = await reader.read();
    if (done) return { text, truncated: false };
    text += decoder.decode(value, { stream: true });
  }
  await reader.cancel();
  return { text: text.slice(0, maxChars), truncated: true };
}

/** Drop query string and fragment (they often carry tokens). */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '[invalid url]';
  }
}
