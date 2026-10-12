import type { Address, Hex } from 'viem';
export type { Address, Hex };

export type TokenKey = 'USDC' | 'AUSD' | 'MON' | 'WMON' | 'WETH' | 'USDT0';
export type TokenRole = 'payout' | 'direct' | 'swapIn' | 'crosschainIn';

/** Mirrors Solidity struct Invoice (field order matters). */
export interface InvoiceMessage {
  merchantId: Hex;
  invoiceId: Hex;
  payoutToken: Address;
  amount: bigint;
  expiresAt: bigint; // uint64 unix seconds
  keyVersion: number; // uint32
}

/** Mirrors Solidity struct PaymentIntent (field order matters). */
export interface PaymentIntentMessage {
  merchantId: Hex;
  invoiceId: Hex;
  payer: Address;
  payoutToken: Address;
  amountOut: bigint;
  route: number; // uint8
  inputToken: Address;
  maxAmountIn: bigint;
  quoteHash: Hex;
  refundTo: Address;
  expiresAt: bigint; // uint64
  nonce: bigint;
  keyVersion: number; // uint32
}

export interface RegistrationMessage {
  owner: Address;
  salt: Hex;
  payoutWallet: Address;
  invoiceSigner: Address;
  payoutToken: Address;
  metadataHash: Hex;
  nonce: bigint;
  deadline: bigint; // uint64
}

export interface SignerRotationMessage {
  merchantId: Hex;
  newSigner: Address;
  nonce: bigint;
  deadline: bigint;
}

export interface PayoutUpdateMessage {
  merchantId: Hex;
  payoutWallet: Address;
  payoutToken: Address;
  nonce: bigint;
  deadline: bigint;
}

export interface ReceiveAuthMessage {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
}

/** Return type of IntentVault.getIntent (viem decodes struct as object). */
export interface IntentRecord {
  payer: Address;
  route: number;
  status: number;
  expiresAt: bigint;
  committedAt: bigint;
  settledAt: bigint;
  merchantId: Hex;
  invoiceId: Hex;
  payoutToken: Address;
  inputToken: Address;
  payoutWallet: Address;
  refundTo: Address;
  amountOut: bigint;
  inputAmount: bigint;
  fee: bigint;
  quoteHash: Hex;
  sourceChainId: bigint;
  sourceTxHash: Hex;
}

/** Return type of MerchantRegistry.getMerchant. */
export interface MerchantRecord {
  owner: Address;
  payoutWallet: Address;
  invoiceSigner: Address;
  payoutToken: Address;
  keyVersion: number;
  status: number;
  registeredAt: bigint;
  metadataHash: Hex;
}

export interface TokenInfo {
  address: Address;
  symbol: string;
  displaySymbol: string;
  decimals: number;
  eip712: { name: string; version: string } | null;
  supports3009: boolean;
  isMock: boolean;
  usdPrice: number;
  roles: TokenRole[];
}

export interface DeployedContract {
  address: Address;
  deployBlock?: number;
  deployTx?: Hex;
}

export interface Deployment {
  schemaVersion: 1;
  chainId: number;
  network: 'local' | 'testnet' | 'mainnet';
  generatedAt: string;
  startBlock: number;
  explorer: string | null;
  contracts: {
    MerchantRegistry: DeployedContract;
    IntentVault: DeployedContract;
    DepositForwarderImpl: DeployedContract;
    SwapAdapter: DeployedContract & { kind: 'mock' | 'kuru' | 'none' };
  };
  roles: { admin: Address; operator: Address; feeRecipient: Address };
  config: {
    feeBps: number;
    refundDelaySec: number;
    crossChainInputToken: TokenKey | null;
    amountCaps: Partial<Record<TokenKey, string>>;
  };
  tokens: Partial<Record<TokenKey, TokenInfo>>;
  external: {
    kuruFlowApi: string | null;
    kuruTargets: Address[];
    auroraMonadUsdcAssetId: string | null;
  };
}

// ---------------------------------------------------------------- B compatibility aliases
// backend-b was written against `a-stubs.ts`, which used these names. They are exact
// aliases of the real types, kept so B's code compiles unchanged after the merge.

/** Shape returned by `splitSignature` — the EIP-3009 authorization signature parts. */
export interface Auth3009Like {
  v: number;
  r: Hex;
  s: Hex;
}

/** @deprecated use {@link TokenInfo} */
export type TokenConfig = TokenInfo;

/** @deprecated use {@link Deployment} */
export type DeploymentConfig = Deployment;
