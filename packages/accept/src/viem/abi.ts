import { BaseError, ContractFunctionRevertedError, ExecutionRevertedError, type Hex, encodeFunctionData, parseAbi } from 'viem';
import type { TransferCall } from '../ports.js';

/** The FiatToken (USDC) v2.2 surface the middleware uses, and nothing else. */
export const TOKEN_ABI = parseAbi([
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)',
]);

export const TOKEN_EVENTS = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
]);

const ECDSA_HEX_LENGTH = 2 + 65 * 2;

/**
 * The calldata of the one call a seller makes. A 65-byte signature goes as (v, r, s), which every
 * FiatToken v2 accepts; a longer one (an ERC-1271 contract wallet) needs the v2.2 bytes overload.
 */
export function transferData(call: TransferCall): Hex {
  const a = call.authorization;
  const head = [a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce] as const;
  if (call.signature.length !== ECDSA_HEX_LENGTH) {
    return encodeFunctionData({ abi: TOKEN_ABI, functionName: 'transferWithAuthorization', args: [...head, call.signature] });
  }
  const r = `0x${call.signature.slice(2, 66)}` as Hex;
  const s = `0x${call.signature.slice(66, 130)}` as Hex;
  const raw = parseInt(call.signature.slice(130, 132), 16);
  return encodeFunctionData({ abi: TOKEN_ABI, functionName: 'transferWithAuthorization', args: [...head, raw < 27 ? raw + 27 : raw, r, s] });
}

/** The revert inside a viem error, if the call executed and reverted; undefined for anything else (an outage). */
export function revertOf(error: unknown): string | undefined {
  if (!(error instanceof BaseError)) return undefined;
  const found = error.walk((e) => e instanceof ContractFunctionRevertedError || e instanceof ExecutionRevertedError);
  if (!(found instanceof BaseError)) return undefined;
  return (found as { reason?: string }).reason ?? found.details ?? found.shortMessage;
}
