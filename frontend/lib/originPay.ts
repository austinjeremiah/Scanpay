/**
 * Paying the cross-chain leg from the customer's OWN passkey wallet, without them ever
 * holding gas on the origin chain.
 *
 * The origin stablecoins we support are Circle-native USDC, which implements EIP-3009.
 * So the customer signs a `transferWithAuthorization` — a message, not a transaction —
 * and our relayer submits it and pays the origin-chain gas. The destination, amount and
 * deadline are all inside the signature, so the relay cannot redirect or inflate it.
 *
 * This keeps one promise on every chain: the wallet holds the stablecoin and nothing else.
 */
import { createPublicClient, http, type Address, type Hex, type LocalAccount } from 'viem';
import { buildTransferAuthTypedData, randomBytes32 } from './shared';

export interface OriginChainInfo {
  chainId: number;
  name: string;
  rpc: string;
  usdc: { address: Address; decimals: number; eip712: { name: string; version: string } };
}

/** Must stay in step with backend/services/api/src/services/originChains.ts */
export const ORIGIN_CHAINS: Record<number, OriginChainInfo> = {
  8453: {
    chainId: 8453,
    name: 'Base',
    rpc: process.env.NEXT_PUBLIC_RPC_8453 ?? 'https://mainnet.base.org',
    usdc: {
      address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      decimals: 6,
      eip712: { name: 'USD Coin', version: '2' },
    },
  },
};

const erc20 = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

/** What the wallet holds of the origin stablecoin. Native gas is deliberately not checked. */
export async function originBalance(chainId: number, owner: Address): Promise<bigint> {
  const c = ORIGIN_CHAINS[chainId];
  if (!c) return 0n;
  const pub = createPublicClient({ transport: http(c.rpc) });
  return pub.readContract({ address: c.usdc.address, abi: erc20, functionName: 'balanceOf', args: [owner] }) as Promise<bigint>;
}

export interface SignedOriginAuth {
  originChainId: number;
  from: Address;
  to: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
  signature: Hex;
}

/** Sign the authorization. Costs nothing and touches no chain. */
export async function signOriginAuth(
  originChainId: number,
  account: LocalAccount,
  to: Address,
  value: bigint,
  validForSeconds = 3600,
): Promise<SignedOriginAuth> {
  const c = ORIGIN_CHAINS[originChainId];
  if (!c) throw new Error(`${originChainId} is not a supported origin chain`);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const message = {
    from: account.address as Address,
    to,
    value,
    validAfter: 0n,
    validBefore: now + BigInt(validForSeconds),
    nonce: randomBytes32(),
  };
  const signature = await account.signTypedData(
    buildTransferAuthTypedData(originChainId, c.usdc, message) as never,
  );
  return {
    originChainId,
    from: message.from,
    to: message.to,
    value: message.value.toString(),
    validAfter: message.validAfter.toString(),
    validBefore: message.validBefore.toString(),
    nonce: message.nonce,
    signature,
  };
}
