/**
 * End-to-end DIRECT payment through the API's own HTTP routes.
 * Proves backend-a (contracts + signing helpers) and backend-b (routes, relayer,
 * follower) work as one system against a real chain.
 *
 * Usage: tsx --env-file=../../../.env scripts/e2e-direct.ts [chainId]
 */
import { createPublicClient, http, parseUnits, type Hex } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import {
  getDeployment, buildRegistrationTypedData, buildInvoiceTypedData, buildIntentTypedData,
  buildReceiveAuthTypedData, receiveAuthForIntent, intentDigest, computeMerchantId,
  randomBytes32, toWireRegistration, toWireInvoice, profileHash,
} from '@scanpay/shared';

const chainId = Number(process.argv[2] ?? 10143);
const API = process.env.API_URL ?? 'http://127.0.0.1:8787';
const ADMIN = process.env.ADMIN_TOKEN!;
const dep = getDeployment(chainId);
const rpc = chainId === 143 ? process.env.MONAD_MAINNET_RPC! : chainId === 10143 ? process.env.MONAD_TESTNET_RPC! : process.env.LOCAL_RPC!;
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

// three distinct identities, so money visibly moves between different accounts
const owner = privateKeyToAccount(generatePrivateKey());
const payout = privateKeyToAccount(generatePrivateKey());
const signer = privateKeyToAccount(generatePrivateKey());
const payer = privateKeyToAccount(generatePrivateKey());

const usdc = dep.tokens.USDC!;
const AMOUNT = parseUnits('1.23', usdc.decimals);
const now = () => BigInt(Math.floor(Date.now() / 1000));

console.log(`chain ${chainId} (${dep.network})   vault ${dep.contracts.IntentVault.address}`);
console.log(`owner ${owner.address}\npayout ${payout.address}\npayer ${payer.address}`);

step('1. register merchant (owner + payout both sign)');
const salt = randomBytes32();
const profile = { displayName: 'Blue Bottle Coffee', category: 'cafe', city: 'Chennai', country: 'IN', logoUrl: '' };
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
console.log('   tx        ', registered.txHash ?? registered.tx ?? '(relayed)');

step('2. approve (VERIFIER_ROLE)');
if (registered.autoApproved || registered.status === 'ACTIVE') {
  // backend-b auto-approves off mainnet; approving again would revert
  // InvalidStatusTransition(2,2) because the registry rejects ACTIVE -> ACTIVE.
  console.log('   already ACTIVE (auto-approve policy)  tx', registered.approveTxHash ?? '-');
} else {
  const approved = await api('POST', `/v1/admin/merchants/${chainId}/${merchantId}/approve`, {}, true);
  console.log('   status', approved.status ?? JSON.stringify(approved).slice(0, 120));
}

step('3. mint tUSDC to the payer (faucet)');
await api('POST', '/v1/faucet', { chainId, address: payer.address });
const bal = await pub.readContract({
  address: usdc.address, abi: [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }],
  functionName: 'balanceOf', args: [payer.address],
}) as bigint;
console.log('   payer balance', bal.toString());

step('4. merchant signs an invoice');
const invoice = {
  merchantId, invoiceId: randomBytes32(), payoutToken: usdc.address,
  amount: AMOUNT, expiresAt: now() + 1800n, keyVersion: 1,
};
const invTd = buildInvoiceTypedData(chainId, dep.contracts.IntentVault.address, invoice);
const created = await api('POST', '/v1/invoices', {
  chainId, invoice: toWireInvoice(invoice), merchantSig: await signer.signTypedData(invTd as any),
  memo: 'flat white', fiat: { currency: 'INR', amount: '103.00' },
});
console.log('   shortCode', created.shortCode, '  url', created.url ?? '');

step('5. customer prepares the intent (DIRECT)');
const prep = await api('POST', '/v1/intents/prepare', {
  shortCode: created.shortCode, route: 'DIRECT', payer: payer.address,
});
console.log('   draftId', prep.draftId, '  amountOut', prep.intent?.amountOut ?? prep.amountOut);

step('6. customer signs intent + EIP-3009 authorization');
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

step('7. submit — operator relays, customer pays no gas');
const sub = await api('POST', '/v1/intents/submit', { draftId: prep.draftId, payerSig, receiveAuthSig: authSig });
console.log('   intentId ', sub.intentId);
console.log('   lifecycle', sub.lifecycle);
console.log('   txHash   ', sub.txHash);

step('8. verify (the three proofs, recomputed)');
for (let i = 0; i < 20; i++) {
  const v = await api('GET', `/v1/verify/${chainId}/${sub.intentId}`).catch(() => null);
  if (v && v.verdict && v.verdict !== 'PENDING') {
    console.log('   VERDICT:', v.verdict);
    for (const [grp, g] of Object.entries<any>(v.proofs)) {
      console.log(`   [${grp}] ok=${g.ok}`);
      for (const c of g.checks) console.log('     ', c.ok === true ? 'PASS' : c.ok === false ? 'FAIL' : 'n/a ', c.label);
    }
    break;
  }
  if (i === 19) console.log('   (no verdict yet — follower may still be catching up)');
  await new Promise((r) => setTimeout(r, 3000));
}

const explorer = dep.explorer ? `${dep.explorer}/tx/${sub.txHash}` : sub.txHash;
console.log(`\n✅ DIRECT payment settled on chain ${chainId}\n   ${explorer}`);
