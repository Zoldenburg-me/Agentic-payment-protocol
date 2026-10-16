const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;

/** Every URL cut to scheme and host: a provider key in a path, query or userinfo never reaches the log. */
export function redactUrls(text: string): string {
  return text.replace(URL_IN_TEXT, (found) => {
    try {
      const url = new URL(found);
      return `${url.protocol}//${url.host}`;
    } catch {
      return '[url]';
    }
  });
}

/** One JSON line: name, code and short message, URLs redacted. The cause is left out (viem nests the RPC URL there). */
export function errorLine(error: unknown): string {
  const e = error as { name?: unknown; code?: unknown; shortMessage?: unknown; message?: unknown } | undefined;
  const message = redactUrls(String(e?.shortMessage ?? e?.message ?? error));
  return JSON.stringify({ level: 'error', name: redactUrls(String(e?.name)), code: e?.code, message });
}
