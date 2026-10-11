import { AcceptError, AcceptErrorCode as E } from '../errors.js';

export const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = /^0x0{40}$/;

export const fail = (what: string): never => {
  throw new AcceptError(E.CONFIG_INVALID, `viem option ${what} is invalid`);
};

export function onlyKnown(options: object, known: readonly string[]): void {
  if (typeof options !== 'object' || options === null) fail('(options)');
  if (Object.keys(options).some((k) => !known.includes(k))) fail('(unknown key)');
}

export function address(value: unknown, name: string): `0x${string}` {
  return typeof value === 'string' && ADDRESS.test(value) && !ZERO_ADDRESS.test(value) ? (value as `0x${string}`) : fail(name);
}

export function positiveInt(value: unknown, fallback: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= max ? (value as number) : fail(name);
}

export function bigintAtLeast(value: unknown, min: bigint, name: string, fallback?: bigint): bigint {
  if (value === undefined && fallback !== undefined) return fallback;
  return typeof value === 'bigint' && value >= min ? value : fail(name);
}

export const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
