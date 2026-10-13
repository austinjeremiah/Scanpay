import { createPublicClient, createWalletClient, erc20Abi, http, maxUint256, type Hex, type LocalAccount } from 'viem';
import { foundry, monad, monadTestnet } from 'viem/chains';
import { merchantRegistryAbi } from './shared';
import { ENV } from './env';

const CHAINS = { 31337: foundry, 10143: monadTestnet, 143: monad } as const;
const clients = new Map<number, ReturnType<typeof createPublicClient>>();

export function publicClient(chainId: number) {
  let c = clients.get(chainId);
  if (!c) {
    c = createPublicClient({ chain: CHAINS[chainId as keyof typeof CHAINS], transport: http(ENV.RPC[chainId]) });
    clients.set(chainId, c);
  }
  return c;
}

export async function tokenBalance(chainId: number, token: Hex, owner: Hex): Promise<bigint> {
  return publicClient(chainId).readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] });
}

export async function nativeBalance(chainId: number, owner: Hex): Promise<bigint> {
  return publicClient(chainId).getBalance({ address: owner });
}

export async function ownerNonce(chainId: number, registry: Hex, owner: Hex): Promise<bigint> {
  return publicClient(chainId).readContract({
    address: registry,
    abi: merchantRegistryAbi,
    functionName: 'ownerNonce',
    args: [owner],
  }) as Promise<bigint>;
}

/** The ONLY transaction the browser sends: one-time approve for the SWAP route (gas dripped by the API). */
export async function approveMax(chainId: number, account: LocalAccount, token: Hex, spender: Hex): Promise<Hex> {
  const chain = CHAINS[chainId as keyof typeof CHAINS];
  const pub = publicClient(chainId);
  const wallet = createWalletClient({ account, chain, transport: http(ENV.RPC[chainId]) });
  const gas = await pub.estimateContractGas({
    address: token, abi: erc20Abi, functionName: 'approve', args: [spender, maxUint256], account,
  });
  const hash = await wallet.writeContract({
    address: token, abi: erc20Abi, functionName: 'approve', args: [spender, maxUint256], gas: (gas * 12n) / 10n, chain, account,
  });
  await pub.waitForTransactionReceipt({ hash });
  return hash;
}
