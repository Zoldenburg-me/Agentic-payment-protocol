import type { MppSigner } from '../types.js';

/**
 * Fake MPP signer for tests and demos: produces a made-up transaction hash and moves no
 * funds. A real Tempo/Stripe MPP signer must submit the transfer and return its hash.
 */
export function mockMppSigner(source = 'did:pkh:eip155:4217:0x0000000000000000000000000000000000000001'): MppSigner {
  return {
    source,
    async payMpp() {
      return { payload: { type: 'hash', hash: `0x${'ab'.repeat(32)}` } };
    },
  };
}
