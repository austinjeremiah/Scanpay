import { createPublicClient, createWalletClient, http, type Address, type Chain, type LocalAccount, type PublicClient, type WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry, monadTestnet } from 'viem/chains';
import { getDeployment, hasDeployment, type DeploymentConfig, type TokenConfig } from '@scanpay/shared';
import type { TokenKey } from '@scanpay/shared';
import type { Env } from './env.js';
import { operatorKeyFor } from './env.js';

export interface ChainCtx {
  chainId: number;
  chain: Chain;
  isMainnet: boolean;
  public: PublicClient;
  wallet: WalletClient;
  operator: { address: Address };
  vault: Address;
  registry: Address;
  adapter: Address | null;
  adapterKind: 'mock' | 'kuru' | 'none';
  deployment: DeploymentConfig;
  features: DeploymentConfig['features'];
  token(key: TokenKey): TokenConfig | undefined;
  tokenByAddress(address: string): { key: TokenKey; token: TokenConfig } | undefined;
  walletFrom(account: LocalAccount): WalletClient;
  explorerTx(hash: string): string | null;
  explorerAddress(address: string): string | null;
}

const contexts = new Map<number, ChainCtx>();

function viemChain(chainId: number) {
  if (chainId === 31337) return foundry;
  if (chainId === 10143) return monadTestnet;
  // mainnet — build a minimal chain object
  return { id: chainId, name: 'Monad', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.monad.xyz'] } } } as any;
}

function rpcUrl(env: Env, chainId: number): string {
  if (chainId === 31337) return env.LOCAL_RPC;
  if (chainId === 10143) return env.MONAD_TESTNET_RPC;
  return env.MONAD_MAINNET_RPC;
}

export function initChains(env: Env): void {
  for (const chainId of env.ENABLED_CHAINS) {
    if (!hasDeployment(chainId)) throw new Error(`No deployment for chainId ${chainId}`);
    const dep = getDeployment(chainId);
    const key = operatorKeyFor(env, chainId);
    if (!key) throw new Error(`No operator key for chainId ${chainId}`);
    const account = privateKeyToAccount(key);
    const chain = viemChain(chainId);
    const transport = http(rpcUrl(env, chainId));
    const publicClient = createPublicClient({ chain, transport });
    const walletClient = createWalletClient({ account, chain, transport });

    const vaultAddr = dep.contracts.IntentVault?.address as Address;
    const registryAddr = dep.contracts.MerchantRegistry?.address as Address;
    const adapterAddr = dep.contracts.MockSwapAdapter?.address as Address | undefined;
    const adapterKind: ChainCtx['adapterKind'] = adapterAddr ? 'mock' : dep.features.swap ? 'kuru' : 'none';

    const explorerBase = chainId === 10143 ? 'https://testnet.monadexplorer.com' : chainId === 143 ? 'https://monadexplorer.com' : null;

    const ctx: ChainCtx = {
      chainId,
      chain,
      isMainnet: chainId === 143,
      public: publicClient as unknown as PublicClient,
      wallet: walletClient as unknown as WalletClient,
      operator: { address: account.address },
      vault: vaultAddr,
      registry: registryAddr,
      adapter: adapterAddr ?? null,
      adapterKind,
      deployment: dep,
      features: dep.features,
      token(key: TokenKey) { return dep.tokens[key]; },
      tokenByAddress(address: string) {
        const lc = address.toLowerCase();
        for (const [k, t] of Object.entries(dep.tokens) as [TokenKey, TokenConfig][]) {
          if (t.address.toLowerCase() === lc) return { key: k, token: t };
        }
        return undefined;
      },
      walletFrom(acc: LocalAccount) {
        return createWalletClient({ account: acc, chain, transport }) as unknown as WalletClient;
      },
      explorerTx: (hash) => explorerBase ? `${explorerBase}/tx/${hash}` : null,
      explorerAddress: (addr) => explorerBase ? `${explorerBase}/address/${addr}` : null,
    };
    contexts.set(chainId, ctx);
  }
}

export function chainCtx(chainId: number): ChainCtx {
  const ctx = contexts.get(chainId);
  if (!ctx) throw new Error(`Chain ${chainId} not enabled`);
  return ctx;
}

export function allChains(): ChainCtx[] {
  return [...contexts.values()];
}
