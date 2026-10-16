const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
/** Causes nest (viem wraps 3–4 deep); past this the rest is dropped rather than passed on unredacted. */
const MAX_DEPTH = 6;

/** Every URL cut to scheme and host: a provider key in a path, query or userinfo never leaves. */
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

function redactValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return redactUrls(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth));
  if (value instanceof Error) return depth >= MAX_DEPTH ? undefined : redactError(value, depth + 1);
  return value;
}

/**
 * A copy of an error with every URL in its strings (message, stack, cause, viem's url/details/
 * metaMessages) cut to scheme and host. Same prototype, so `instanceof` and `code` still work; the
 * original is left as it was.
 */
export function redactError(error: unknown, depth = 0): unknown {
  if (!(error instanceof Error)) return redactValue(error, depth);
  const copy = Object.create(Object.getPrototypeOf(error) as object) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(error)) {
    const d = Object.getOwnPropertyDescriptor(error, key);
    if (d === undefined) continue;
    // Getters are read once; a throwing one is left out rather than taking the report down.
    let value: unknown;
    try {
      value = 'value' in d ? d.value : d.get?.call(error);
    } catch {
      continue;
    }
    Object.defineProperty(copy, key, { value: redactValue(value, depth), writable: true, configurable: true, enumerable: d.enumerable ?? false });
  }
  return copy;
}
