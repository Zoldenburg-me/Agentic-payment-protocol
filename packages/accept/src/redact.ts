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

/** Request parts viem attaches to errors: headers carry Authorization, bodies the signed payment. */
const DROPPED = new Set(['headers', 'body', 'request']);

const isPlain = (v: object): boolean => [Object.prototype, null].includes(Object.getPrototypeOf(v) as object | null);

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactUrls(value);
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value)) return '[circular]';
  if (depth >= MAX_DEPTH) return undefined;
  if (Array.isArray(value)) {
    seen.add(value);
    return value.map((v) => redactValue(v, depth + 1, seen));
  }
  // Errors and plain objects are copied field by field; anything else (a Buffer, a class) is not passed on.
  if (!(value instanceof Error) && !isPlain(value)) return `[${value.constructor?.name ?? 'object'}]`;
  seen.add(value);
  const copy = Object.create(Object.getPrototypeOf(value) as object | null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'string' && DROPPED.has(key)) continue;
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (d === undefined) continue;
    // Getters are read once; a throwing one is left out rather than taking the report down.
    let v: unknown;
    try {
      v = 'value' in d ? d.value : d.get?.call(value);
    } catch {
      continue;
    }
    Object.defineProperty(copy, key, { value: redactValue(v, depth + 1, seen), writable: true, configurable: true, enumerable: d.enumerable ?? false });
  }
  return copy;
}

/**
 * A copy of what was thrown with every URL in its strings (message, stack, causes, nested objects,
 * viem's url/details/metaMessages) cut to scheme and host, and `headers`/`body`/`request` fields left
 * out. Errors keep their prototype, so `instanceof` and `code` still work; the original is unchanged.
 */
export function redactError(error: unknown): unknown {
  return redactValue(error, 0, new WeakSet());
}
