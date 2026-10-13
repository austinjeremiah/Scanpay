/**
 * Cross-chain e2e on mainnet (chain 143) — commits the intent, gets a deposit address.
 * The user must send USDC from Base/Ethereum to that address to complete the payment.
 *
 * Usage: tsx --env-file=../../../.env scripts/e2e-crosschain-mainnet.ts
 */
import { createPublicClient, http, parseUnits, type Hex } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import {
  getDeployment, buildRegistrationTypedData, buildInvoiceTypedData, buildIntentTypedData,
  toWireRegistration, toWireInvoice, profileHash, computeMerchantId, randomBytes32,
} from '@scanpay/shared';

const chainId = 143;
const API = process.env.API_URL ?? 'http://127.0.0.1:8787';
const ADMIN = process.env.ADMIN_TOKEN!;
const dep = getDeployment(chainId);
const rpc = process.env.MONAD_MAINNET_RPC!;
const pub = createPublicClient({ transport: http(rpc) });

const step = (n: string) => console.log(`\n── ${n}`);
async function api(method: string, path: string, body?: unknown, admin = false) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(admin ? { authorization: `Bearer ${ADMIN}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json: any; try { json = JSON.parse(text); } catch { json = text; }
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}\n${JSON.stringify(json, null, 2)}`);
  return json;
}

const owner  = privateKeyToAccount(generatePrivateKey());
const payout = privateKeyToAccount(generatePrivateKey());
const signer = privateKeyToAccount(generatePrivateKey());
const payer  = privateKeyToAccount(process.env.MAINNET_PAYER_PRIVATE_KEY as Hex);

const usdc   = dep.tokens.USDC!;
const AMOUNT = parseUnits('0.15', usdc.decimals); // 0.15 USDC (Aurora min is ~0.15)
const now    = () => BigInt(Math.floor(Date.now() / 1000));

console.log(`\nchain 143 (mainnet)  vault ${dep.contracts.IntentVault.address}`);
console.log(`payer  ${payer.address}`);

step('1. register merchant (auto-approved)');
const salt = randomBytes32();
const profile = { displayName: 'CrossChain Test', category: 'demo', city: 'Chennai', country: 'IN', logoUrl: '' };
const reg = {
  owner: owner.address, salt, payoutWallet: payout.address, invoiceSigner: signer.address,
  payoutToken: usdc.address, metadataHash: profileHash(profile), nonce: 0n, deadline: now() + 3600n,
};
const regTd = buildRegistrationTypedData(chainId, dep.contracts.MerchantRegistry.address, reg);
const merchantId = computeMerchantId(owner.address, salt);
const registered = await api('POST', '/v1/merchants/register', {
  chainId, registration: toWireRegistration(reg),
  ownerSig: await owner.signTypedData(regTd as any),
  payoutSig: await payout.signTypedData(regTd as any),
  profile,
});
console.log('   merchantId', merchantId);
console.log('   status    ', registered.status);

step('2. create invoice (0.05 USDC)');
const invoice = {
  merchantId, invoiceId: randomBytes32(), payoutToken: usdc.address,
  amount: AMOUNT, expiresAt: now() + 3600n, keyVersion: 1,
};
const invTd = buildInvoiceTypedData(chainId, dep.contracts.IntentVault.address, invoice);
const created = await api('POST', '/v1/invoices', {
  chainId, invoice: toWireInvoice(invoice),
  merchantSig: await signer.signTypedData(invTd as any),
  memo: 'cross-chain test',
});
console.log('   shortCode', created.shortCode);

step('3. get available cross-chain origin assets');
const routes = await api('GET', `/v1/routes?shortCode=${created.shortCode}`);
console.log('   features:', JSON.stringify(routes.features ?? {}));
console.log('   crosschain:', routes.crosschain ?? 'none');
const originAssets: any[] = routes.crosschain?.originAssets ?? [];
console.log('   origin assets:', originAssets.length);
originAssets.slice(0, 5).forEach((a: any) => console.log(`     ${a.symbol} on ${a.blockchain} (chainId ${a.evmChainId})`));

if (originAssets.length === 0) {
  console.log('\n⚠️  No origin assets returned — Aurora API may be unreachable from backend');
  console.log('   Cross-chain route requires Aurora/1Click bridge to be available');
  process.exit(0);
}

// Pick Base USDC if available, otherwise first asset
const baseUsdc = originAssets.find((a: any) => a.symbol === 'USDC' && a.blockchain === 'base') ?? originAssets[0];
console.log(`\n   Selected: ${baseUsdc.symbol} on ${baseUsdc.blockchain} (${baseUsdc.assetId?.slice(0, 50)})`);

step('4. prepare CROSSCHAIN intent');
const prep = await api('POST', '/v1/intents/prepare', {
  shortCode: created.shortCode,
  route: 'CROSSCHAIN',
  payer: payer.address,
  origin: { assetId: baseUsdc.assetId, refundTo: payer.address },
});
console.log('   draftId       ', prep.draftId);
console.log('   depositAddress', prep.crosschain?.depositAddress ?? '(none)');
console.log('   amountIn      ', prep.crosschain?.originAmountIn, baseUsdc.symbol, '(you send this)');
console.log('   amountOut     ', prep.intent?.amountOut, 'USDC (merchant receives)');

step('5. sign intent + commit on-chain');
const intent = {
  ...prep.intent,
  amountOut: BigInt(prep.intent.amountOut), maxAmountIn: BigInt(prep.intent.maxAmountIn),
  expiresAt: BigInt(prep.intent.expiresAt), nonce: BigInt(prep.intent.nonce),
};
const { buildIntentTypedData: bI } = await import('@scanpay/shared');
const intentTd = bI(chainId, dep.contracts.IntentVault.address, intent as any);
const payerSig = await payer.signTypedData(intentTd as any);

const sub = await api('POST', '/v1/intents/submit', { draftId: prep.draftId, payerSig });
console.log('   intentId ', sub.intentId);
console.log('   lifecycle', sub.lifecycle);
console.log('   commitTx ', sub.txHash);

console.log('\n══════════════════════════════════════════════════════════');
console.log('  CROSS-CHAIN PAYMENT READY');
console.log('══════════════════════════════════════════════════════════');
console.log(`  Send ${prep.crosschain?.originAmountIn ?? '?'} ${baseUsdc.symbol} from ${baseUsdc.blockchain}`);
console.log(`  To deposit address: ${prep.crosschain?.depositAddress}`);
console.log(`  Aurora will bridge it → merchant receives 0.05 USDC on Monad`);
console.log(`\n  Commit tx: https://monadscan.com/tx/${sub.txHash}`);
console.log('══════════════════════════════════════════════════════════\n');
