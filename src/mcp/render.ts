import { formatUsd } from '../assets.js';
import type { HubResult, QuoteReport } from '../hub.js';
import { readCapped } from '../net-guard.js';

const MAX_BODY_CHARS = 20_000;

export const text = (value: unknown) => ({
  content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});

export const summarize = (r: QuoteReport) => ({
  protocol: r.quote.protocol,
  payee: r.quote.payee,
  network: r.quote.amount.network,
  asset: r.quote.amount.asset,
  atomicAmount: r.quote.amount.atomic.toString(),
  usd: r.verdict.ok ? formatUsd(r.verdict.usdMicros) : undefined,
  allowedByPolicy: r.verdict.ok,
  blockedReason: r.verdict.ok ? undefined : r.verdict.reason,
  walletCanPay: r.canPay,
});

/** A body that fails mid-read must not turn a completed payment into a tool error (and a retry). */
const readBody = async (res: Response) => {
  try {
    const { text: body, truncated } = await readCapped(res, MAX_BODY_CHARS);
    return { body, ...(truncated ? { truncated: true } : {}) };
  } catch {
    return { body: null, bodyError: 'the response body could not be read' };
  }
};

/** Turns a hub result into MCP tool output. Every non-paid outcome that may cost money says so. */
export async function render(result: HubResult) {
  switch (result.status) {
    case 'free': {
      // Redirects are never followed (payment is bound to the exact URL asked for).
      const location = result.response.headers.get('location');
      return text({
        status: 'free (no payment needed)',
        httpStatus: result.response.status,
        ...(location ? { redirectTo: location } : {}),
        ...(await readBody(result.response)),
      });
    }
    case 'paid':
      return text({
        status: 'paid',
        protocol: result.quote.protocol,
        paidUsd: formatUsd(result.usdMicros),
        receipt: result.receipt?.reference ?? null,
        httpStatus: result.response.status,
        ...(await readBody(result.response)),
      });
    case 'quoted':
      return text({ status: 'quoted (nothing paid)', options: result.quotes.map(summarize) });
    case 'blocked':
      return { ...text({ status: 'blocked: nothing was paid', options: result.quotes.map(summarize) }), isError: true as const };
    case 'rejected':
      return {
        ...text({
          status: "payment rejected by server; the amount is still counted against today's budget because the signed authorization could still be settled",
          protocol: result.quote.protocol,
          httpStatus: result.response.status,
        }),
        isError: true as const,
      };
    case 'unsupported':
      return {
        ...text(result.reason === 'cross-origin'
          ? 'Not paid: the 402 came from a different origin than the URL asked for (a redirect was followed).'
          : 'Server returned 402 but none of the supported payment protocols (x402 v2, MPP charge) was offered for this URL.'),
        isError: true as const,
      };
    default:
      return assertNever(result);
  }
}

function assertNever(value: never): never {
  throw new Error(`unhandled hub result: ${JSON.stringify(value)}`);
}
