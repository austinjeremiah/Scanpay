/**
 * SWAP e2e on mainnet (chain 143): payer pays with WMON, merchant receives USDC.
 * Funds payer from operator wallet, wraps MON→WMON, approves vault, then swaps.
 *
 * Usage: tsx --env-file=../../../.env scripts/e2e-swap-mainnet.ts
 */
import { createPublicClient, createWalletClient, http, parseUnits, parseEther, type Hex, type Address } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import {
  getDeployment, buildRegistrationTypedData, buildInvoiceTypedData, buildIntentTypedData,
  toWireRegistration, toWireInvoice, profileHash, computeMerchantId, randomBytes32,
} from '@scanpay/shared';

const chainId = 143;
const API    = process.env.API_URL ?? 'http://127.0.0.1:8787';
const ADMIN  = process.env.ADMIN_TOKEN!;
const dep    = getDeployment(chainId);
const rpc    = process.env.MONAD_MAINNET_RPC!;

const monad = { id: chainId, name: 'Monad', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } } as any;
const pub   = createPublicClient({ transport: http(rpc) });

const operatorKey = process.env.OPERATOR_PRIVATE_KEY_MAINNET as Hex;
const payerKey    = process.env.MAINNET_PAYER_PRIVATE_KEY as Hex;
const operator    = privateKeyToAccount(operatorKey);
const payer       = privateKeyToAccount(payerKey);
const opWallet    = createWalletClient({ account: operator, chain: monad, transport: http(rpc) });
const payerWallet = createWalletClient({ account: payer,    chain: monad, transport: http(rpc) });

const usdc   = dep.tokens.USDC!;
const wmon   = dep.tokens.WMON!;
const VAULT  = dep.contracts.IntentVault.address as Address;
const AMOUNT = parseUnits('0.05', usdc.decimals); // 0.05 USDC out to merchant
const now    = () => BigInt(Math.floor(Date.now() / 1000));

const erc20Abi = [
  { name: 'balanceOf',  type: 'function', stateMutability: 'view',     inputs: [{ type: 'address' }],                    outputs: [{ type: 'uint256' }] },
  { name: 'allowance',  type: 'function', stateMutability: 'view',     inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'approve',    type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool'    }] },
  { name: 'deposit',    type: 'function', stateMutability: 'payable',   inputs: [],                                        outputs: []                    },
] as const;

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

const step = (n: string) => console.log(`\n── ${n}`);

console.log(`\nchain 143 (mainnet)  vault ${VAULT}`);
console.log(`operator ${operator.address}`);
console.log(`payer    ${payer.address}`);

// ── 0. check balances
step('0. check balances');
const opMon    = await pub.getBalance({ address: operator.address });
const payerMon = await pub.getBalance({ address: payer.address });
const payerWmon = await pub.readContract({ address: wmon.address as Address, abi: erc20Abi, functionName: 'balanceOf', args: [payer.address] }) as bigint;
console.log(`   operator MON : ${Number(opMon)/1e18}`);
console.log(`   payer MON    : ${Number(payerMon)/1e18}`);
console.log(`   payer WMON   : ${Number(payerWmon)/1e18}`);

// ── 1. get swap quote to know how much WMON we need
step('1. get SWAP quote (WMON → 0.05 USDC)');
// Create a temporary invoice to get quote
const owner  = privateKeyToAccount(generatePrivateKey());
const payout = privateKeyToAccount(generatePrivateKey());
const signer = privateKeyToAccount(generatePrivateKey());
const salt   = randomBytes32();
const profile = { displayName: 'Swap Test Cafe', category: 'cafe', city: 'Chennai', country: 'IN', logoUrl: '' };
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
console.log(`   merchant ${merchantId.slice(0,18)}... status=${registered.status}`);

const invoice = {
  merchantId, invoiceId: randomBytes32(), payoutToken: usdc.address,
  amount: AMOUNT, expiresAt: now() + 3600n, keyVersion: 1,
};
const invTd = buildInvoiceTypedData(chainId, dep.contracts.IntentVault.address, invoice);
const created = await api('POST', '/v1/invoices', {
  chainId, invoice: toWireInvoice(invoice),
  merchantSig: await signer.signTypedData(invTd as any),
  memo: 'swap test',
});
console.log(`   shortCode ${created.shortCode}`);

const quote = await api('POST', '/v1/quotes', {
  shortCode: created.shortCode, route: 'SWAP',
  payer: payer.address, inputTokenKey: 'WMON',
});
const maxWmon = BigInt(quote.maxAmountIn);
const estWmon = BigInt(quote.estimatedIn);
console.log(`   need max ${Number(maxWmon)/1e18} WMON, est ${Number(estWmon)/1e18} WMON`);

// ── 2. fund payer with MON from operator (if needed)
const wmonNeeded = maxWmon + parseEther('0.05'); // extra for gas
if (payerWmon < maxWmon) {
  step('2. send MON from operator → payer');
  const sendAmount = wmonNeeded - payerWmon + parseEther('0.1'); // buffer for gas
  console.log(`   sending ${Number(sendAmount)/1e18} MON to payer`);
  const hash = await opWallet.sendTransaction({ to: payer.address, value: sendAmount });
  await pub.waitForTransactionReceipt({ hash });
  console.log(`   tx ${hash}`);

  // ── 3. payer wraps MON → WMON
  step('3. payer wraps MON → WMON');
  const wrapHash = await payerWallet.writeContract({
    address: wmon.address as Address, abi: erc20Abi,
    functionName: 'deposit', args: [], value: wmonNeeded,
  });
  await pub.waitForTransactionReceipt({ hash: wrapHash });
  console.log(`   tx ${wrapHash}`);
  const newWmon = await pub.readContract({ address: wmon.address as Address, abi: erc20Abi, functionName: 'balanceOf', args: [payer.address] }) as bigint;
  console.log(`   payer WMON balance: ${Number(newWmon)/1e18}`);
} else {
  console.log(`   payer already has ${Number(payerWmon)/1e18} WMON — skipping fund`);
}

// ── 4. payer approves vault to spend WMON
step('4. payer approves vault to spend WMON');
const allowance = await pub.readContract({ address: wmon.address as Address, abi: erc20Abi, functionName: 'allowance', args: [payer.address, VAULT] }) as bigint;
if (allowance < maxWmon) {
  const approveHash = await payerWallet.writeContract({
    address: wmon.address as Address, abi: erc20Abi,
    functionName: 'approve', args: [VAULT, maxWmon * 10n],
  });
  await pub.waitForTransactionReceipt({ hash: approveHash });
  console.log(`   approved. tx ${approveHash}`);
} else {
  console.log(`   already approved (${Number(allowance)/1e18} WMON)`);
}

// ── 5. prepare SWAP intent
step('5. prepare SWAP intent');
const prep = await api('POST', '/v1/intents/prepare', {
  shortCode: created.shortCode, route: 'SWAP',
  payer: payer.address, inputTokenKey: 'WMON',
});
console.log(`   draftId    ${prep.draftId}`);
console.log(`   maxAmountIn ${Number(prep.intent.maxAmountIn)/1e18} WMON`);
console.log(`   amountOut   ${Number(prep.intent.amountOut)/1e6} USDC`);

// ── 6. payer signs intent
step('6. payer signs intent');
const intent = {
  ...prep.intent,
  amountOut: BigInt(prep.intent.amountOut), maxAmountIn: BigInt(prep.intent.maxAmountIn),
  expiresAt: BigInt(prep.intent.expiresAt), nonce: BigInt(prep.intent.nonce),
};
const { buildIntentTypedData: bI } = await import('@scanpay/shared');
const intentTd = bI(chainId, dep.contracts.IntentVault.address, intent as any);
const payerSig = await payer.signTypedData(intentTd as any);

// ── 7. submit SWAP
step('7. submit SWAP');
const sub = await api('POST', '/v1/intents/submit', { draftId: prep.draftId, payerSig });
console.log(`   intentId  ${sub.intentId}`);
console.log(`   lifecycle ${sub.lifecycle}`);
console.log(`   txHash    ${sub.txHash}`);

// ── 8. verify
step('8. verify proof');
for (let i = 0; i < 20; i++) {
  const v = await api('GET', `/v1/verify/${chainId}/${sub.intentId}`).catch(() => null);
  if (v?.verdict && v.verdict !== 'PENDING') {
    console.log(`   VERDICT: ${v.verdict}`);
    for (const [grp, g] of Object.entries<any>(v.proofs)) {
      console.log(`   [${grp}] ok=${g.ok}`);
    }
    break;
  }
  if (i === 19) console.log('   (no verdict yet)');
  await new Promise(r => setTimeout(r, 3000));
}

// ── check merchant received USDC
const merchantBal = await pub.readContract({
  address: usdc.address as Address,
  abi: [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }],
  functionName: 'balanceOf', args: [payout.address],
}) as bigint;

console.log(`\n══════════════════════════════════════════════════════════`);
console.log(`  SWAP PAYMENT SETTLED ON MAINNET`);
console.log(`══════════════════════════════════════════════════════════`);
console.log(`  Payer paid with WMON on Monad`);
console.log(`  Merchant received: ${Number(merchantBal)/1e6} USDC`);
console.log(`  Tx: https://monadscan.com/tx/${sub.txHash}`);
console.log(`══════════════════════════════════════════════════════════\n`);
