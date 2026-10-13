/**
 * Origin chains for the CROSSCHAIN route.
 *
 * These are chains the customer pays *from*. We hold no contracts there — the only thing
 * we do is relay a customer-signed EIP-3009 `transferWithAuthorization` that moves their
 * stablecoin to the 1Click deposit address.
 *
 * That keeps the product's promise on every chain: the customer signs, never holds gas,
 * and never installs a wallet. The destination and amount are inside the signature, so
 * relaying it cannot redirect or inflate the payment — the same guarantee the vault gives
 * on Monad, enforced by the token itself here.
 */
import { createPublicClient, createWalletClient, defineChain, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ApiError } from '../errors.js';
import { log } from '../log.js';

const TRANSFER_WITH_AUTHORIZATION_ABI = [
  {
    type: 'function',
    name: 'transferWithAuthorization',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
      { name: 'v', type: 'uint8' },
      { name: 'r', type: 'bytes32' },
      { name: 's', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'authorizationState',
    stateMutability: 'view',
    inputs: [
      { name: 'authorizer', type: 'address' },
      { name: 'nonce', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

export interface OriginToken {
  key: 'USDC';
  address: Address;
  decimals: number;
  /** EIP-712 domain of the token itself, which 3009 signatures are checked against. */
  eip712: { name: string; version: string };
  /** 1Click asset id, so a quote can be requested for this exact origin asset. */
  assetId: string;
}

export interface OriginChain {
  chainId: number;
  name: string;
  rpcEnv: string;
  explorer: string;
  tokens: Record<'USDC', OriginToken>;
}

/** Verified on-chain: Base USDC is Circle native and exposes TRANSFER_WITH_AUTHORIZATION_TYPEHASH. */
export const ORIGIN_CHAINS: Record<number, OriginChain> = {
  8453: {
    chainId: 8453,
    name: 'Base',
    rpcEnv: 'BASE_RPC',
    explorer: 'https://basescan.org',
    tokens: {
      USDC: {
        key: 'USDC',
        address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        decimals: 6,
        eip712: { name: 'USD Coin', version: '2' },
        assetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
      },
    },
  },
};

export const isOriginChain = (chainId: number) => chainId in ORIGIN_CHAINS;
export const originChain = (chainId: number) => {
  const c = ORIGIN_CHAINS[chainId];
  if (!c) throw new ApiError('CHAIN_NOT_ENABLED', `Chain ${chainId} is not a supported origin chain`);
  return c;
};

function rpcUrl(c: OriginChain) {
  const url = process.env[c.rpcEnv];
  if (!url) throw new ApiError('ROUTE_UNAVAILABLE', `${c.rpcEnv} is not configured`);
  return url;
}

function clients(c: OriginChain) {
  const url = rpcUrl(c);
  const chain = defineChain({
    id: c.chainId,
    name: c.name,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [url] } },
  });
  const key = process.env.ORIGIN_RELAYER_PRIVATE_KEY as Hex | undefined;
  if (!key) throw new ApiError('ROUTE_UNAVAILABLE', 'ORIGIN_RELAYER_PRIVATE_KEY is not configured');
  const account = privateKeyToAccount(key);
  return {
    pub: createPublicClient({ chain, transport: http(url) }),
    wallet: createWalletClient({ account, chain, transport: http(url) }),
    account,
    chain,
  };
}

export interface OriginAuth {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
  signature: Hex;
}

/** Split a 65-byte signature the way EIP-3009 wants it. */
function vrs(sig: Hex) {
  const h = sig.slice(2);
  if (h.length !== 130) throw new ApiError('VALIDATION_ERROR', 'signature must be 65 bytes');
  const r = `0x${h.slice(0, 64)}` as Hex;
  const s = `0x${h.slice(64, 128)}` as Hex;
  let v = parseInt(h.slice(128, 130), 16);
  if (v < 27) v += 27;
  return { v, r, s };
}

/**
 * Relay the customer's signed authorization on the origin chain. We pay the gas there.
 *
 * Everything that matters is inside what the customer signed, so the only thing this
 * function can do is execute their intent or fail — it cannot alter the destination,
 * the amount, or the deadline.
 */
export async function relayOriginTransfer(chainId: number, auth: OriginAuth) {
  const c = originChain(chainId);
  const token = c.tokens.USDC;
  const { pub, wallet, account, chain } = clients(c);

  const used = (await pub.readContract({
    address: token.address,
    abi: TRANSFER_WITH_AUTHORIZATION_ABI,
    functionName: 'authorizationState',
    args: [auth.from, auth.nonce],
  })) as boolean;
  if (used) throw new ApiError('REPLAY_BLOCKED', 'This origin authorization was already used');

  const balance = (await pub.readContract({
    address: token.address,
    abi: TRANSFER_WITH_AUTHORIZATION_ABI,
    functionName: 'balanceOf',
    args: [auth.from],
  })) as bigint;
  if (balance < auth.value) {
    throw new ApiError('INSUFFICIENT_BALANCE', `Need ${auth.value} on ${c.name}, wallet holds ${balance}`);
  }

  const { v, r, s } = vrs(auth.signature);
  const args = [auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce, v, r, s] as const;

  // Simulate first so a bad signature surfaces as a clear error instead of a burnt transaction.
  try {
    await pub.simulateContract({
      account: account.address,
      address: token.address,
      abi: TRANSFER_WITH_AUTHORIZATION_ABI,
      functionName: 'transferWithAuthorization',
      args,
    });
  } catch (e: any) {
    log.warn({ err: e?.shortMessage ?? String(e) }, 'origin transfer simulation failed');
    throw new ApiError('INVALID_PAYER_SIGNATURE', 'The origin-chain authorization is not valid for this token');
  }

  const hash = await wallet.writeContract({
    address: token.address,
    abi: TRANSFER_WITH_AUTHORIZATION_ABI,
    functionName: 'transferWithAuthorization',
    args,
    chain,
    account,
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  log.info({ chainId, hash, to: auth.to, value: auth.value.toString() }, 'origin transfer relayed');
  return { hash, status: receipt.status, explorer: `${c.explorer}/tx/${hash}` };
}

export async function originRelayerStatus(chainId: number) {
  const c = originChain(chainId);
  const { pub, account } = clients(c);
  return { chainId, name: c.name, relayer: account.address, balance: (await pub.getBalance({ address: account.address })).toString() };
}
