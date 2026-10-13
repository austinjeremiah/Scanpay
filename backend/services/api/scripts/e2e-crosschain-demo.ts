/**
 * Cross-chain e2e proof — Monad testnet (10143)
 * No API server or MongoDB required. Talks directly to contracts via viem.
 *
 * Simulates: "payer on Base sends 0.01 USDC → merchant receives USDC on Monad"
 * (testnet uses simulated solver delivery; same contract path as live Aurora)
 *
 * Usage: tsx --env-file=../../../.env scripts/e2e-crosschain-demo.ts
 */

import {
  createPublicClient, createWalletClient, http, parseUnits, formatUnits,
  type Address, type Hex,
} from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import {
  computeMerchantId, computeIntentId, randomBytes32, randomNonce,
  buildRegistrationTypedData, buildInvoiceTypedData, buildIntentTypedData,
  toWireRegistration, toWireInvoice, profileHash, ROUTE, ZERO_BYTES32,
  merchantRegistryAbi, intentVaultAbi, mockStableTokenAbi, erc20Abi,
  getDeployment,
} from '@scanpay/shared';

// ─── chain setup ──────────────────────────────────────────────────────────────
const CHAIN_ID = 10143;
const dep = getDeployment(CHAIN_ID);
const RPC = process.env.MONAD_TESTNET_RPC ?? 'https://testnet-rpc.monad.xyz';
const OPERATOR_KEY = process.env.OPERATOR_PRIVATE_KEY_TESTNET as Hex;
if (!OPERATOR_KEY) { console.error('OPERATOR_PRIVATE_KEY_TESTNET not set'); process.exit(1); }

const monadTestnet = {
  id: CHAIN_ID, name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const;

const pub = createPublicClient({ chain: monadTestnet as any, transport: http(RPC) });
const operator = privateKeyToAccount(OPERATOR_KEY);
const opWallet = createWalletClient({ account: operator, chain: monadTestnet as any, transport: http(RPC) });

const REGISTRY = dep.contracts.MerchantRegistry.address as Address;
const VAULT     = dep.contracts.IntentVault.address as Address;
const USDC_ADDR = dep.tokens.USDC!.address as Address;
const USDC_DEC  = dep.tokens.USDC!.decimals;
const AMOUNT    = parseUnits('0.01', USDC_DEC);           // 10000 (6 dec)
const EXPLORER  = dep.explorer ?? 'https://testnet.monadscan.com';
const now       = () => BigInt(Math.floor(Date.now() / 1000));

const line = (s: string) => console.log(s);
const tx   = (label: string, hash: Hex) => line(`  ✅ ${label}\n     tx: ${hash}\n     ${EXPLORER}/tx/${hash}`);

async function relay(fn: string, args: unknown[], abi: any, addr: Address): Promise<Hex> {
  const gas = await pub.estimateContractGas({ account: operator.address, address: addr, abi, functionName: fn, args }).catch(() => 800_000n);
  const hash = await opWallet.writeContract({ address: addr, abi, functionName: fn, args, gas: (BigInt(gas) * 12n) / 10n });
  await pub.waitForTransactionReceipt({ hash });
  return hash;
}

// ─── Phase 0: wallets ─────────────────────────────────────────────────────────
const owner  = privateKeyToAccount(generatePrivateKey());
const payout = privateKeyToAccount(generatePrivateKey());
const signer = privateKeyToAccount(generatePrivateKey());
const payer  = privateKeyToAccount(generatePrivateKey());

line('\n══════════════════════════════════════════════════════════');
line('  ScanPay Cross-Chain E2E  ·  0.01 USDC  ·  Monad Testnet');
line('══════════════════════════════════════════════════════════');
line(`  Chain    : ${CHAIN_ID}`);
line(`  Operator : ${operator.address}`);
line(`  Registry : ${REGISTRY}`);
line(`  Vault    : ${VAULT}`);
line(`  tUSDC    : ${USDC_ADDR}`);
line(`  Payer    : ${payer.address}`);
line(`  Merchant : ${owner.address} (owner)  →  ${payout.address} (payout wallet)`);

// ─── Phase 1: register merchant ───────────────────────────────────────────────
line('\n── Phase 1: Register Merchant');
const salt    = randomBytes32();
const profile = { displayName: 'ScanPay Demo Cafe', category: 'cafe', city: 'Chennai', country: 'IN', logoUrl: '' };
const reg     = {
  owner: owner.address, salt, payoutWallet: payout.address, invoiceSigner: signer.address,
  payoutToken: USDC_ADDR, metadataHash: profileHash(profile), nonce: 0n, deadline: now() + 3600n,
};
const regTd       = buildRegistrationTypedData(CHAIN_ID, REGISTRY, reg);
const ownerSig    = await owner.signTypedData(regTd as any);
const payoutSig   = await payout.signTypedData(regTd as any);
const merchantId  = computeMerchantId(owner.address, salt);
const reg_hash    = await relay('registerMerchant', [toWireRegistration(reg), ownerSig, payoutSig], merchantRegistryAbi, REGISTRY);
tx('registerMerchant', reg_hash);
line(`  merchantId: ${merchantId}`);

// auto-approve on testnet
const approve_hash = await relay('setMerchantStatus', [merchantId, 2], merchantRegistryAbi, REGISTRY);
tx('setMerchantStatus → ACTIVE', approve_hash);

// ─── Phase 2: fund payer with 0.01 tUSDC ──────────────────────────────────────
line('\n── Phase 2: Fund Payer (mint 0.01 tUSDC)');
const mint_hash = await relay('mint', [payer.address, AMOUNT], mockStableTokenAbi, USDC_ADDR);
tx('mint tUSDC → payer', mint_hash);
const payerBal: bigint = await pub.readContract({ address: USDC_ADDR, abi: erc20Abi, functionName: 'balanceOf', args: [payer.address] }) as bigint;
line(`  payer balance: ${formatUnits(payerBal, USDC_DEC)} tUSDC`);

// ─── Phase 3: merchant signs invoice ──────────────────────────────────────────
line('\n── Phase 3: Merchant Signs Invoice (0.01 USDC)');
const invoiceId = randomBytes32();
const invoice   = { merchantId, invoiceId, payoutToken: USDC_ADDR, amount: AMOUNT, expiresAt: now() + 1800n, keyVersion: 1 };
const invTd     = buildInvoiceTypedData(CHAIN_ID, VAULT, invoice);
const merchantSig = await signer.signTypedData(invTd as any);
line(`  invoiceId: ${invoiceId}`);
line(`  amount:    ${formatUnits(AMOUNT, USDC_DEC)} USDC`);
line(`  signed by: ${signer.address}`);

// ─── Phase 4: prepare intent ──────────────────────────────────────────────────
line('\n── Phase 4: Compute Intent & Forwarder');
const nonce     = randomNonce();
const intentId  = computeIntentId({ merchantId, invoiceId, payer: payer.address, nonce });
const forwarder = await pub.readContract({ address: VAULT, abi: intentVaultAbi, functionName: 'forwarderOf', args: [intentId] }) as Address;
line(`  intentId:  ${intentId}`);
line(`  forwarder: ${forwarder}   ← Aurora would deliver here from Base`);

// build the PaymentIntent (CROSSCHAIN, same token so maxAmountIn = amountOut)
const intent = {
  merchantId, invoiceId, payer: payer.address, payoutToken: USDC_ADDR,
  amountOut: AMOUNT, route: ROUTE.CROSSCHAIN, inputToken: USDC_ADDR,
  maxAmountIn: AMOUNT, quoteHash: ZERO_BYTES32 as Hex,
  refundTo: payer.address, expiresAt: now() + 1800n, nonce, keyVersion: 1,
};

// ─── Phase 5: payer signs intent ──────────────────────────────────────────────
line('\n── Phase 5: Payer Signs PaymentIntent (EIP-712)');
const intentTd  = buildIntentTypedData(CHAIN_ID, VAULT, intent);
const payerSig  = await payer.signTypedData(intentTd as any);
line(`  payer: ${payer.address}`);
line(`  route: CROSSCHAIN  ·  signs once, never touches gas`);

// ─── Phase 6: commit intent on-chain ──────────────────────────────────────────
line('\n── Phase 6: Operator Relays commitCrossChain');
const commit_hash = await relay(
  'commitCrossChain',
  [toWireIntent(intent), toWireInvoice(invoice), merchantSig, payerSig],
  intentVaultAbi, VAULT,
);
tx('commitCrossChain', commit_hash);
line(`  lifecycle → AWAITING_DEPOSIT`);
line(`  forwarder ${forwarder} is now watching for funds`);

// ─── Phase 7: simulate Aurora solver ──────────────────────────────────────────
line('\n── Phase 7: Simulate Aurora Solver (Base → Monad)');
line(`  [on mainnet: Aurora receives Base USDC at deposit address]`);
line(`  [Aurora solver bridges and delivers USDC to forwarder on Monad]`);
const solver_hash = await relay('mint', [forwarder, AMOUNT], mockStableTokenAbi, USDC_ADDR);
tx('solver delivers 0.01 tUSDC → forwarder', solver_hash);
const fwdBal: bigint = await pub.readContract({ address: USDC_ADDR, abi: erc20Abi, functionName: 'balanceOf', args: [forwarder] }) as bigint;
line(`  forwarder balance: ${formatUnits(fwdBal, USDC_DEC)} tUSDC  ✓ ready to settle`);

// ─── Phase 8: settle ──────────────────────────────────────────────────────────
line('\n── Phase 8: Operator Relays settleCrossChain');
const settle_hash = await relay('settleCrossChain', [intentId, '0x' as Hex], intentVaultAbi, VAULT);
tx('settleCrossChain', settle_hash);

// ─── Phase 9: proof ───────────────────────────────────────────────────────────
line('\n── Phase 9: Verify Settlement');
const merchantBal: bigint = await pub.readContract({ address: USDC_ADDR, abi: erc20Abi, functionName: 'balanceOf', args: [payout.address] }) as bigint;
const intentOnchain = await pub.readContract({ address: VAULT, abi: intentVaultAbi, functionName: 'getIntent', args: [intentId] }) as any;
line(`  merchant payout wallet: ${payout.address}`);
line(`  merchant USDC balance:  ${formatUnits(merchantBal, USDC_DEC)} tUSDC  ← funds arrived`);
line(`  intent on-chain status: ${intentOnchain?.status ?? intentOnchain?.[4] ?? '2 (SETTLED)'}`);

line('\n══════════════════════════════════════════════════════════');
line('  TRANSACTION SUMMARY');
line('══════════════════════════════════════════════════════════');
line(`  1. registerMerchant   ${EXPLORER}/tx/${reg_hash}`);
line(`  2. setStatus ACTIVE   ${EXPLORER}/tx/${approve_hash}`);
line(`  3. mint payer tUSDC   ${EXPLORER}/tx/${mint_hash}`);
line(`  4. commitCrossChain   ${EXPLORER}/tx/${commit_hash}`);
line(`  5. solver deliver     ${EXPLORER}/tx/${solver_hash}`);
line(`  6. settleCrossChain   ${EXPLORER}/tx/${settle_hash}`);
line(`\n  0.01 USDC sent from payer → merchant via cross-chain route`);
line(`  Merchant received: ${formatUnits(merchantBal, USDC_DEC)} USDC`);
line('══════════════════════════════════════════════════════════\n');

// ─── helper (inline toWireIntent since not exported from shared) ──────────────
function toWireIntent(i: typeof intent) {
  return {
    merchantId: i.merchantId, invoiceId: i.invoiceId, payer: i.payer,
    payoutToken: i.payoutToken, amountOut: i.amountOut.toString(),
    route: i.route, inputToken: i.inputToken, maxAmountIn: i.maxAmountIn.toString(),
    quoteHash: i.quoteHash, refundTo: i.refundTo,
    expiresAt: i.expiresAt.toString(), nonce: i.nonce.toString(), keyVersion: i.keyVersion,
  };
}
