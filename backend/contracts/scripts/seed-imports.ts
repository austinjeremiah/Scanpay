export * from '@scanpay/shared';
import { keccak256, toBytes } from 'viem';
export const keccak256Utf8 = (s: string) => keccak256(toBytes(s));
