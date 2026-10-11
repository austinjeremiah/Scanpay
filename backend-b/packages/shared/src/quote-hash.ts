import { keccak256, toBytes, type Address, type Hex } from 'viem';
import { canonicalJson } from './canonical.js';

export interface QuoteHashFields {
  v: 1;
  chainId: number;
  route: 'SWAP' | 'CROSSCHAIN';
  provider: 'none' | 'mock' | 'kuru' | 'aurora' | 'oneclick' | 'simulated';
  quoteId: string;
  inputToken: Address;
  payoutToken: Address;
  amountOut: string;
  maxAmountIn: string;
  depositAddress: string | null;
  recipient: Address | null;
  originAsset: string | null;
  originAmountIn: string | null;
  deadline: number;
}

export function quoteHash(fields: QuoteHashFields): Hex {
  return keccak256(toBytes(canonicalJson(fields)));
}

export function profileHash(profile: {
  displayName: string;
  category: string;
  city: string;
  country: string;
  logoUrl: string;
}): Hex {
  return keccak256(toBytes(canonicalJson(profile)));
}
