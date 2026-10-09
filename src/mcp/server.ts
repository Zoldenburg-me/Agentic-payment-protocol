#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { UNSUPPORTED_PROTOCOLS } from '../adapters/index.js';
import { formatUsd } from '../assets.js';
import { hubFromEnv } from '../config.js';
import type { HubResult, QuoteReport } from '../hub.js';
import { assertPublicHttps, readCapped, redactUrl } from '../net-guard.js';

const MAX_BODY_CHARS = 20_000;

const requestShape = {
  url: z.string().url().describe('The https URL of the paid resource'),
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE']).default('GET'),
  headers: z.record(z.string(), z.string()).optional().describe('Extra request headers'),
  body: z.string().optional().describe('Request body (string)'),
};

const hub = hubFromEnv();
const server = new McpServer({ name: 'agentpay-hub', version: '0.1.0' });

const text = (value: unknown) => ({
  content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});

/** Returns an error result if the URL must not be fetched, else undefined. */
async function refuse(url: string, spending: boolean) {
  const fail = (message: string) => ({ ...text(message), isError: true as const });
  if (spending && hub.policy.allowedHosts.length === 0) {
    return fail('payment_fetch is disabled until AGENTPAY_ALLOWED_HOSTS lists the hosts this agent may pay. Use payment_quote to inspect prices.');
  }
  try {
    await assertPublicHttps(url);
  } catch (error) {
    return fail(`URL refused: ${error instanceof Error ? error.message : 'invalid URL'}`);
  }
  return undefined;
}

const summarize =(r: QuoteReport) => ({
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

const readBody = async (res: Response) => {
  const { text: body, truncated } = await readCapped(res, MAX_BODY_CHARS);
  return { body, ...(truncated ? { truncated: true } : {}) };
};

async function render(result: HubResult) {
  switch (result.status) {
    case 'free':
      return text({
        status: 'free (no payment needed)',
        httpStatus: result.response.status,
        // Redirects are never followed (payment is bound to the exact URL asked for).
        ...(result.response.headers.get('location') ? { redirectTo: result.response.headers.get('location') } : {}),
        ...(await readBody(result.response)),
      });
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
      return { ...text({ status: 'blocked: nothing was paid', options: result.quotes.map(summarize) }), isError: true };
    case 'rejected':
      return { ...text({ status: 'payment rejected by server; reservation released', protocol: result.quote.protocol }), isError: true };
    case 'unsupported':
      return { ...text('Server returned 402 but none of the supported payment protocols (x402 v2, MPP charge) was offered.'), isError: true };
  }
}

server.registerTool(
  'payment_quote',
  {
    description: 'Check what a URL costs and which payment protocols it accepts. Never pays. Call this before payment_fetch for unfamiliar services.',
    inputSchema: requestShape,
  },
  async ({ url, headers }) => {
    // GET only: a quote must not trigger side effects on the remote service.
    const refused = await refuse(url, false);
    if (refused) return refused;
    return render(await hub.request(url, { method: 'GET', ...(headers && { headers }) }, 'quote'));
  },
);

server.registerTool(
  'payment_fetch',
  {
    description: 'Fetch a URL and automatically pay if it asks for payment over x402 or MPP, within the configured spend limits. Picks the cheapest payable protocol. Spends real money when a funded wallet is configured.',
    inputSchema: requestShape,
  },
  async ({ url, method, headers, body }) => {
    const refused = await refuse(url, true);
    if (refused) return refused;
    return render(await hub.request(url, { method, ...(headers && { headers }), ...(body !== undefined && { body }) }, 'pay'));
  },
);

server.registerTool(
  'payment_status',
  { description: 'Show spend limits, today\'s spend, protocols this hub can pay with, and recent payments.' },
  async () =>
    text({
      payableProtocols: hub.payableProtocols(),
      policy: {
        maxPerTx: formatUsd(hub.policy.maxPerTxUsdMicros),
        dailyBudget: formatUsd(hub.policy.dailyBudgetUsdMicros),
        allowedHosts: hub.policy.allowedHosts,
        allowedProtocols: hub.policy.allowedProtocols,
      },
      spentToday: formatUsd(hub.ledger.spentToday()),
      recent: hub.ledger.entries().slice(-10).map((e) => ({ ...e, url: redactUrl(e.url) })),
      notYetSupported: UNSUPPORTED_PROTOCOLS,
    }),
);

await server.connect(new StdioServerTransport());
