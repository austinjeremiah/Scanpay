/**
 * Stubs for Backend-A-owned content (ABIs, deployment configs, typed-data builders).
 * Replace with real implementations from I0-I4 when Backend A delivers.
 */
import { keccak256, toBytes, parseAbi, type Address, type Hex } from 'viem';
import type { TokenKey } from './api.js';

// ------------------------------------------------------------------ constants
export const ICD_VERSION = 1;
export const ZERO_BYTES32 = ('0x' + '00'.repeat(32)) as Hex;

export const MERCHANT_STATUS = { NONE: 0, PENDING: 1, ACTIVE: 2, SUSPENDED: 3, REVOKED: 4 } as const;
export const MERCHANT_STATUS_NAME = ['NONE', 'PENDING', 'ACTIVE', 'SUSPENDED', 'REVOKED'] as const;
export const INVOICE_STATE = { OPEN: 0, RESERVED: 1, PAID: 2 } as const;
export const ROUTE = { DIRECT: 0, SWAP: 1, CROSSCHAIN: 2 } as const;
export const INTENT_STATUS = { NONE: 0, COMMITTED: 1, SETTLED: 2, REFUNDED: 3 } as const;

// ------------------------------------------------------------------ randomness
export const randomBytes32 = (): Hex => `0x${[...Array(64)].map(() => Math.floor(Math.random() * 16).toString(16)).join('')}` as Hex;
export const randomNonce = (): bigint => BigInt('0x' + [...Array(32)].map(() => Math.floor(Math.random() * 16).toString(16)).join(''));

// ------------------------------------------------------------------ minimal ABIs
export const merchantRegistryAbi = parseAbi([
  'function registerMerchant((address owner, bytes32 salt, address payoutWallet, address invoiceSigner, address payoutToken, bytes32 metadataHash, uint256 nonce, uint256 deadline) reg, bytes ownerSig, bytes payoutSig) external',
  'function setMerchantStatus(bytes32 merchantId, uint8 newStatus) external',
  'function rotateInvoiceSigner((bytes32 merchantId, address newSigner, uint256 nonce, uint256 deadline) rot, bytes ownerSig) external',
  'function updatePayout((bytes32 merchantId, address payoutWallet, address payoutToken, uint256 nonce, uint256 deadline) upd, bytes ownerSig, bytes payoutSig) external',
  'function getMerchant(bytes32 merchantId) external view returns ((address owner, bytes32 salt, address payoutWallet, address invoiceSigner, address payoutToken, bytes32 metadataHash, uint8 status, uint8 keyVersion, uint256 registeredAt))',
  'function ownerNonce(address owner) external view returns (uint256)',
  'event MerchantRegistered(bytes32 indexed merchantId, address indexed owner, bytes32 salt, address payoutWallet, address invoiceSigner, address payoutToken, bytes32 metadataHash, uint256 registeredAt)',
  'event MerchantStatusChanged(bytes32 indexed merchantId, uint8 oldStatus, uint8 newStatus)',
  'event InvoiceSignerRotated(bytes32 indexed merchantId, address indexed invoiceSigner, uint8 keyVersion)',
  'event PayoutUpdated(bytes32 indexed merchantId, address payoutWallet, address payoutToken, uint8 keyVersion)',
]);

export const intentVaultAbi = parseAbi([
  'function payDirect((bytes32 merchantId, bytes32 invoiceId, address payer, address payoutToken, uint256 amountOut, uint8 route, address inputToken, uint256 maxAmountIn, bytes32 quoteHash, address refundTo, uint256 expiresAt, uint256 nonce, uint8 keyVersion) intent, (bytes32 merchantId, bytes32 invoiceId, address payoutToken, uint256 amount, uint256 expiresAt, uint8 keyVersion) invoice, bytes merchantSig, bytes payerSig, (uint8 v, bytes32 r, bytes32 s) auth) external',
  'function paySwap((bytes32 merchantId, bytes32 invoiceId, address payer, address payoutToken, uint256 amountOut, uint8 route, address inputToken, uint256 maxAmountIn, bytes32 quoteHash, address refundTo, uint256 expiresAt, uint256 nonce, uint8 keyVersion) intent, (bytes32 merchantId, bytes32 invoiceId, address payoutToken, uint256 amount, uint256 expiresAt, uint8 keyVersion) invoice, bytes merchantSig, bytes payerSig, bytes swapData) external',
  'function commitCrossChain((bytes32 merchantId, bytes32 invoiceId, address payer, address payoutToken, uint256 amountOut, uint8 route, address inputToken, uint256 maxAmountIn, bytes32 quoteHash, address refundTo, uint256 expiresAt, uint256 nonce, uint8 keyVersion) intent, (bytes32 merchantId, bytes32 invoiceId, address payoutToken, uint256 amount, uint256 expiresAt, uint8 keyVersion) invoice, bytes merchantSig, bytes payerSig) external',
  'function settleCrossChain(bytes32 intentId, bytes swapData) external',
  'function refundCrossChain(bytes32 intentId) external',
  'function attestSource(bytes32 intentId, uint256 sourceChainId, bytes32 sourceTxHash, bytes32 providerRef) external',
  'function forwarderOf(bytes32 intentId) external view returns (address)',
  'function amountCap(address token) external view returns (uint256)',
  'function invoiceState(bytes32 merchantId, bytes32 invoiceId) external view returns (uint8)',
  'function getIntent(bytes32 intentId) external view returns ((bytes32 merchantId, bytes32 invoiceId, address payer, address payoutWallet, address payoutToken, uint256 amountOut, uint8 route, address inputToken, uint256 maxAmountIn, bytes32 quoteHash, address refundTo, uint256 expiresAt, uint256 nonce, uint8 keyVersion, uint8 status, uint256 fee, bytes32 sourceTxHash, uint256 sourceChainId, uint256 settledAt))',
  'event IntentCommitted(bytes32 indexed intentId, bytes32 indexed merchantId, bytes32 invoiceId, address payer, uint8 route, address forwarder)',
  'event PaymentSettled(bytes32 indexed intentId, bytes32 indexed merchantId, bytes32 invoiceId, address indexed payoutWallet, uint256 amountOut, uint256 fee, uint256 inputAmount, uint256 excessRefunded)',
  'event IntentRefunded(bytes32 indexed intentId, address indexed refundTo, uint256 amount)',
  'event SourceAttested(bytes32 indexed intentId, uint256 sourceChainId, bytes32 sourceTxHash)',
]);

export const mockSwapAdapterAbi = parseAbi([
  'function quoteIn(address tokenIn, address tokenOut, uint256 amountOut) external view returns (uint256)',
  'function rateE18(address tokenIn, address tokenOut) external view returns (uint256)',
]);

export const mockStableTokenAbi = parseAbi([
  'function mint(address to, uint256 amount) external',
  'function burn(address from, uint256 amount) external',
]);

export const erc20Abi = parseAbi([
  'function balanceOf(address account) external view returns (uint256)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function transfer(address to, uint256 amount) external returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) external returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
]);

// ------------------------------------------------------------------ token config type
export interface TokenConfig {
  address: Address;
  decimals: number;
  symbol: string;
  roles: string[];
  supports3009: boolean;
  isMock: boolean;
  usdPrice: number;
  eip712?: { name: string; version: string };
}

// ------------------------------------------------------------------ deployment type
export interface DeploymentConfig {
  contracts: Record<string, { address: Address }>;
  tokens: Partial<Record<TokenKey, TokenConfig>>;
  config: { feeBps: number; refundDelaySec: number; crossChainInputToken: TokenKey | null };
  features: { direct: boolean; swap: boolean; crosschain: 'live' | 'simulated' | 'off'; faucet: boolean; attackLab: boolean; indexer: boolean };
  external: { kuruFlowApi?: string; kuruTargets: Address[]; auroraMonadUsdcAssetId?: string };
  startBlock: number;
}

// ------------------------------------------------------------------ stub deployments (local anvil)
const LOCAL_DEPLOYMENT: DeploymentConfig = {
  contracts: {
    MerchantRegistry: { address: '0x5fbdb2315678afecb367f032d93f642f64180aa3' as Address },
    IntentVault: { address: '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512' as Address },
    MockSwapAdapter: { address: '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0' as Address },
  },
  tokens: {
    USDC: { address: '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9' as Address, decimals: 6, symbol: 'USDC', roles: ['direct', 'payout', 'swapIn'], supports3009: true, isMock: true, usdPrice: 1, eip712: { name: 'ScanPay Test USDC', version: '1' } },
    AUSD: { address: '0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9' as Address, decimals: 6, symbol: 'AUSD', roles: ['payout', 'swapIn'], supports3009: false, isMock: true, usdPrice: 1 },
    MON: { address: '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707' as Address, decimals: 18, symbol: 'MON', roles: ['swapIn'], supports3009: false, isMock: true, usdPrice: 0.025 },
  },
  config: { feeBps: 30, refundDelaySec: 3600, crossChainInputToken: 'USDC' },
  features: { direct: true, swap: true, crosschain: 'simulated', faucet: true, attackLab: true, indexer: false },
  external: { kuruTargets: [] },
  startBlock: 1,
};

const TESTNET_DEPLOYMENT: DeploymentConfig = {
  contracts: {
    MerchantRegistry: { address: '0x0000000000000000000000000000000000000001' as Address },
    IntentVault: { address: '0x0000000000000000000000000000000000000002' as Address },
    MockSwapAdapter: { address: '0x0000000000000000000000000000000000000003' as Address },
  },
  tokens: {
    USDC: { address: '0x0000000000000000000000000000000000000010' as Address, decimals: 6, symbol: 'USDC', roles: ['direct', 'payout', 'swapIn'], supports3009: true, isMock: true, usdPrice: 1, eip712: { name: 'ScanPay Test USDC', version: '1' } },
    AUSD: { address: '0x0000000000000000000000000000000000000011' as Address, decimals: 6, symbol: 'AUSD', roles: ['payout', 'swapIn'], supports3009: false, isMock: true, usdPrice: 1 },
    MON: { address: '0x0000000000000000000000000000000000000012' as Address, decimals: 18, symbol: 'MON', roles: ['swapIn'], supports3009: false, isMock: true, usdPrice: 0.025 },
  },
  config: { feeBps: 30, refundDelaySec: 7200, crossChainInputToken: 'USDC' },
  features: { direct: true, swap: true, crosschain: 'simulated', faucet: true, attackLab: false, indexer: false },
  external: { kuruTargets: [] },
  startBlock: 1,
};

const DEPLOYMENTS: Record<number, DeploymentConfig> = {
  31337: LOCAL_DEPLOYMENT,
  10143: TESTNET_DEPLOYMENT,
};

export function hasDeployment(chainId: number): boolean {
  return chainId in DEPLOYMENTS;
}

export function getDeployment(chainId: number): DeploymentConfig {
  const d = DEPLOYMENTS[chainId];
  if (!d) throw new Error(`No deployment for chainId ${chainId}`);
  return d;
}

export function getToken(chainId: number, key: TokenKey): TokenConfig {
  const d = getDeployment(chainId);
  const t = d.tokens[key];
  if (!t) throw new Error(`Token ${key} not found on chain ${chainId}`);
  return t;
}

// ------------------------------------------------------------------ types mirroring Solidity structs
export interface RegistrationMessage {
  owner: Address; salt: Hex; payoutWallet: Address; invoiceSigner: Address; payoutToken: Address;
  metadataHash: Hex; nonce: bigint; deadline: bigint;
}
export interface SignerRotationMessage { merchantId: Hex; newSigner: Address; nonce: bigint; deadline: bigint; }
export interface PayoutUpdateMessage { merchantId: Hex; payoutWallet: Address; payoutToken: Address; nonce: bigint; deadline: bigint; }
export interface InvoiceMessage { merchantId: Hex; invoiceId: Hex; payoutToken: Address; amount: bigint; expiresAt: bigint; keyVersion: number; }
export interface PaymentIntentMessage {
  merchantId: Hex; invoiceId: Hex; payer: Address; payoutToken: Address; amountOut: bigint; route: number;
  inputToken: Address; maxAmountIn: bigint; quoteHash: Hex; refundTo: Address; expiresAt: bigint; nonce: bigint; keyVersion: number;
}
export interface MerchantRecord {
  owner: Address; salt: Hex; payoutWallet: Address; invoiceSigner: Address; payoutToken: Address;
  metadataHash: Hex; status: number; keyVersion: number; registeredAt: bigint;
}
export interface IntentRecord {
  merchantId: Hex; invoiceId: Hex; payer: Address; payoutWallet: Address; payoutToken: Address; amountOut: bigint;
  route: number; inputToken: Address; maxAmountIn: bigint; quoteHash: Hex; refundTo: Address; expiresAt: bigint;
  nonce: bigint; keyVersion: number; status: number; fee: bigint; sourceTxHash: Hex; sourceChainId: bigint; settledAt: bigint;
}
export interface Auth3009Like { v: number; r: Hex; s: Hex; }

// ------------------------------------------------------------------ wire conversion helpers
import { zWireInvoice, zWireIntent, zWireRegistration, zWireSignerRotation, zWirePayoutUpdate } from './api.js';

export function fromWireInvoice(w: ReturnType<typeof zWireInvoice.parse>): InvoiceMessage {
  return { merchantId: w.merchantId as Hex, invoiceId: w.invoiceId as Hex, payoutToken: w.payoutToken as Address, amount: BigInt(w.amount), expiresAt: BigInt(w.expiresAt), keyVersion: w.keyVersion };
}
export function toWireInvoice(m: InvoiceMessage) {
  return { merchantId: m.merchantId, invoiceId: m.invoiceId, payoutToken: m.payoutToken, amount: m.amount.toString(), expiresAt: m.expiresAt.toString(), keyVersion: m.keyVersion };
}
export function fromWireIntent(w: ReturnType<typeof zWireIntent.parse>): PaymentIntentMessage {
  return { merchantId: w.merchantId as Hex, invoiceId: w.invoiceId as Hex, payer: w.payer as Address, payoutToken: w.payoutToken as Address, amountOut: BigInt(w.amountOut), route: w.route, inputToken: w.inputToken as Address, maxAmountIn: BigInt(w.maxAmountIn), quoteHash: w.quoteHash as Hex, refundTo: w.refundTo as Address, expiresAt: BigInt(w.expiresAt), nonce: BigInt(w.nonce), keyVersion: w.keyVersion };
}
export function toWireIntent(m: PaymentIntentMessage) {
  return { merchantId: m.merchantId, invoiceId: m.invoiceId, payer: m.payer, payoutToken: m.payoutToken, amountOut: m.amountOut.toString(), route: m.route, inputToken: m.inputToken, maxAmountIn: m.maxAmountIn.toString(), quoteHash: m.quoteHash, refundTo: m.refundTo, expiresAt: m.expiresAt.toString(), nonce: m.nonce.toString(), keyVersion: m.keyVersion };
}
export function fromWireRegistration(w: ReturnType<typeof zWireRegistration.parse>): RegistrationMessage {
  return { owner: w.owner as Address, salt: w.salt as Hex, payoutWallet: w.payoutWallet as Address, invoiceSigner: w.invoiceSigner as Address, payoutToken: w.payoutToken as Address, metadataHash: w.metadataHash as Hex, nonce: BigInt(w.nonce), deadline: BigInt(w.deadline) };
}
export function toWireRegistration(m: RegistrationMessage) {
  return { owner: m.owner, salt: m.salt, payoutWallet: m.payoutWallet, invoiceSigner: m.invoiceSigner, payoutToken: m.payoutToken, metadataHash: m.metadataHash, nonce: m.nonce.toString(), deadline: m.deadline.toString() };
}
export function fromWireSignerRotation(w: ReturnType<typeof zWireSignerRotation.parse>): SignerRotationMessage {
  return { merchantId: w.merchantId as Hex, newSigner: w.newSigner as Address, nonce: BigInt(w.nonce), deadline: BigInt(w.deadline) };
}
export function toWireSignerRotation(m: SignerRotationMessage) {
  return { merchantId: m.merchantId, newSigner: m.newSigner, nonce: m.nonce.toString(), deadline: m.deadline.toString() };
}
export function fromWirePayoutUpdate(w: ReturnType<typeof zWirePayoutUpdate.parse>): PayoutUpdateMessage {
  return { merchantId: w.merchantId as Hex, payoutWallet: w.payoutWallet as Address, payoutToken: w.payoutToken as Address, nonce: BigInt(w.nonce), deadline: BigInt(w.deadline) };
}
export function toWirePayoutUpdate(m: PayoutUpdateMessage) {
  return { merchantId: m.merchantId, payoutWallet: m.payoutWallet, payoutToken: m.payoutToken, nonce: m.nonce.toString(), deadline: m.deadline.toString() };
}

// ------------------------------------------------------------------ typed data builders
const DOMAIN_NAME = 'ScanPay';
const DOMAIN_VERSION = '1';

function domain(chainId: number, verifyingContract: Address) {
  return { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId, verifyingContract };
}

export function computeMerchantId(owner: Address, salt: Hex): Hex {
  return keccak256(toBytes(`${owner.toLowerCase()}${salt.toLowerCase().slice(2)}`)) as Hex;
}

export function computeIntentId(intent: { merchantId: Hex; invoiceId: Hex; payer: Address; nonce: bigint }): Hex {
  const nonce = intent.nonce.toString(16).padStart(64, '0');
  return keccak256(toBytes(`${intent.merchantId.toLowerCase()}${intent.invoiceId.toLowerCase().slice(2)}${intent.payer.toLowerCase().slice(2)}${nonce}`)) as Hex;
}

export function intentDigest(chainId: number, vault: Address, intent: PaymentIntentMessage): Hex {
  return keccak256(toBytes(JSON.stringify({ chainId, vault, ...intent, amountOut: intent.amountOut.toString(), maxAmountIn: intent.maxAmountIn.toString(), expiresAt: intent.expiresAt.toString(), nonce: intent.nonce.toString() }))) as Hex;
}

export function receiveAuthForIntent(intent: PaymentIntentMessage, digest: Hex, vault: Address) {
  return { from: intent.payer, to: vault as Address, value: intent.maxAmountIn, validAfter: 0n, validBefore: intent.expiresAt, nonce: digest };
}

export function splitSignature(sig: Hex): Auth3009Like {
  const s = sig.startsWith('0x') ? sig.slice(2) : sig;
  return { r: `0x${s.slice(0, 64)}` as Hex, s: `0x${s.slice(64, 128)}` as Hex, v: parseInt(s.slice(128, 130), 16) };
}

const REGISTRATION_TYPE = [
  { name: 'owner', type: 'address' }, { name: 'salt', type: 'bytes32' }, { name: 'payoutWallet', type: 'address' },
  { name: 'invoiceSigner', type: 'address' }, { name: 'payoutToken', type: 'address' }, { name: 'metadataHash', type: 'bytes32' },
  { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
];

export function buildRegistrationTypedData(chainId: number, registry: Address, reg: RegistrationMessage) {
  return { domain: domain(chainId, registry), primaryType: 'Registration' as const, types: { Registration: REGISTRATION_TYPE }, message: reg };
}

const SIGNER_ROTATION_TYPE = [{ name: 'merchantId', type: 'bytes32' }, { name: 'newSigner', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }];
export function buildSignerRotationTypedData(chainId: number, registry: Address, r: SignerRotationMessage) {
  return { domain: domain(chainId, registry), primaryType: 'SignerRotation' as const, types: { SignerRotation: SIGNER_ROTATION_TYPE }, message: r };
}

const PAYOUT_UPDATE_TYPE = [{ name: 'merchantId', type: 'bytes32' }, { name: 'payoutWallet', type: 'address' }, { name: 'payoutToken', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }];
export function buildPayoutUpdateTypedData(chainId: number, registry: Address, u: PayoutUpdateMessage) {
  return { domain: domain(chainId, registry), primaryType: 'PayoutUpdate' as const, types: { PayoutUpdate: PAYOUT_UPDATE_TYPE }, message: u };
}

const INVOICE_TYPE = [{ name: 'merchantId', type: 'bytes32' }, { name: 'invoiceId', type: 'bytes32' }, { name: 'payoutToken', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'expiresAt', type: 'uint256' }, { name: 'keyVersion', type: 'uint8' }];
export function buildInvoiceTypedData(chainId: number, vault: Address, inv: InvoiceMessage) {
  return { domain: domain(chainId, vault), primaryType: 'Invoice' as const, types: { Invoice: INVOICE_TYPE }, message: inv };
}

const INTENT_TYPE = [
  { name: 'merchantId', type: 'bytes32' }, { name: 'invoiceId', type: 'bytes32' }, { name: 'payer', type: 'address' },
  { name: 'payoutToken', type: 'address' }, { name: 'amountOut', type: 'uint256' }, { name: 'route', type: 'uint8' },
  { name: 'inputToken', type: 'address' }, { name: 'maxAmountIn', type: 'uint256' }, { name: 'quoteHash', type: 'bytes32' },
  { name: 'refundTo', type: 'address' }, { name: 'expiresAt', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'keyVersion', type: 'uint8' },
];
export function buildIntentTypedData(chainId: number, vault: Address, intent: PaymentIntentMessage) {
  return { domain: domain(chainId, vault), primaryType: 'PaymentIntent' as const, types: { PaymentIntent: INTENT_TYPE }, message: intent };
}

const RECEIVE_AUTH_TYPE = [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }];
export function buildReceiveAuthTypedData(chainId: number, token: { address: Address; eip712: { name: string; version: string } } | TokenConfig, msg: ReturnType<typeof receiveAuthForIntent>) {
  const tok = token as any;
  const eip712 = tok.eip712 ?? { name: tok.symbol ?? 'Token', version: '1' };
  return { domain: { name: eip712.name, version: eip712.version, chainId, verifyingContract: tok.address }, primaryType: 'ReceiveWithAuthorization' as const, types: { ReceiveWithAuthorization: RECEIVE_AUTH_TYPE }, message: msg };
}
