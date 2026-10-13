/**
 * Mainnet e2e: real USDC, no faucet.
 * Uses MAINNET_PAYER_PRIVATE_KEY from .env (funded with real USDC).
 * Usage: tsx --env-file=../../../.env scripts/e2e-mainnet.ts
 */
import { createPublicClient, http, parseUnits, type Hex } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import {
  getDeployment, buildRegistrationTypedData, buildInvoiceTypedData, buildIntentTypedData,
  buildReceiveAuthTypedData, receiveAuthForIntent, intentDigest, computeMerchantId,
  randomBytes32, toWireRegistration, toWireInvoice, profileHash,
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
const AMOUNT = parseUnits('0.10', usdc.decimals); // 0.10 real USDC
const now    = () => BigInt(Math.floor(Date.now() / 1000));

console.log(`chain 143 (mainnet)  vault ${dep.contracts.IntentVault.address}`);
console.log(`owner  ${owner.address}\npayout ${payout.address}\npayer  ${payer.address}`);

const payerBal = await pub.readContract({
  address: usdc.address as `0x${string}`,
  abi: [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }],
  functionName: 'balanceOf', args: [payer.address],
}) as bigint;
console.log(`payer USDC balance: ${Number(payerBal) / 1e6} USDC`);
if (payerBal < AMOUNT) throw new Error(`Payer has ${Number(payerBal)/1e6} USDC, need ${Number(AMOUNT)/1e6}`);

step('1. register merchant');
const salt = randomBytes32();
const profile = { displayName: 'ScanPay Demo', category: 'demo', city: 'Chennai', country: 'IN', logoUrl: '' };
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
console.log('   tx        ', registered.txHash ?? '(relayed)');

step('2. approve merchant');
if (registered.autoApproved || registered.status === 'ACTIVE') {
  console.log('   already ACTIVE (auto-approve policy)');
} else {
  await api('POST', `/v1/admin/merchants/${chainId}/${merchantId}/approve`, {}, true);
  console.log('   approved');
}

step('3. merchant signs invoice (0.10 USDC)');
const invoice = {
  merchantId, invoiceId: randomBytes32(), payoutToken: usdc.address,
  amount: AMOUNT, expiresAt: now() + 1800n, keyVersion: 1,
};
const invTd = buildInvoiceTypedData(chainId, dep.contracts.IntentVault.address, invoice);
const created = await api('POST', '/v1/invoices', {
  chainId, invoice: toWireInvoice(invoice),
  merchantSig: await signer.signTypedData(invTd as any),
  memo: 'mainnet test', fiat: { currency: 'USD', amount: '0.10' },
});
console.log('   shortCode', created.shortCode);

step('4. prepare DIRECT intent');
const prep = await api('POST', '/v1/intents/prepare', {
  shortCode: created.shortCode, route: 'DIRECT', payer: payer.address,
});
console.log('   draftId', prep.draftId, '  amountOut', prep.intent?.amountOut);

step('5. sign intent + EIP-3009 auth');
const intent = {
  ...prep.intent,
  amountOut: BigInt(prep.intent.amountOut), maxAmountIn: BigInt(prep.intent.maxAmountIn),
  expiresAt: BigInt(prep.intent.expiresAt), nonce: BigInt(prep.intent.nonce),
};
const intentTd = buildIntentTypedData(chainId, dep.contracts.IntentVault.address, intent as any);
const payerSig = await payer.signTypedData(intentTd as any);
const digest = intentDigest(chainId, dep.contracts.IntentVault.address, intent as any);
const authMsg = receiveAuthForIntent(intent as any, digest, dep.contracts.IntentVault.address);
const authSig = await payer.signTypedData(buildReceiveAuthTypedData(chainId, usdc, authMsg) as any);

step('6. submit');
const sub = await api('POST', '/v1/intents/submit', { draftId: prep.draftId, payerSig, receiveAuthSig: authSig });
console.log('   intentId ', sub.intentId);
console.log('   lifecycle', sub.lifecycle);
console.log('   txHash   ', sub.txHash);

step('7. verify 3-layer proof');
for (let i = 0; i < 20; i++) {
  const v = await api('GET', `/v1/verify/${chainId}/${sub.intentId}`).catch(() => null);
  if (v?.verdict && v.verdict !== 'PENDING') {
    console.log('   VERDICT:', v.verdict);
    for (const [grp, g] of Object.entries<any>(v.proofs)) {
      console.log(`   [${grp}] ok=${g.ok}`);
      for (const c of g.checks) console.log('     ', c.ok === true ? 'PASS' : 'FAIL', c.label);
    }
    break;
  }
  if (i === 19) console.log('   (no verdict yet)');
  await new Promise(r => setTimeout(r, 3000));
}

console.log(`\n✅ MAINNET DIRECT payment settled on chain 143`);
console.log(`   https://monadscan.com/tx/${sub.txHash}`);
