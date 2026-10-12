/**
 * End-to-end proof for every payment route, through the API's own HTTP routes.
 *
 *   tsx --env-file=../../../.env scripts/e2e-routes.ts <chainId> [DIRECT|SWAP|CROSSCHAIN|all]
 *
 * Testnet mints its own funds via the faucet. On mainnet the payer must already
 * hold value, so PAYER_PRIVATE_KEY must be supplied.
 */
import { createPublicClient, createWalletClient, defineChain, http, parseUnits, formatUnits, type Hex, type Address } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import {
  getDeployment, buildRegistrationTypedData, buildInvoiceTypedData, buildIntentTypedData,
  buildReceiveAuthTypedData, receiveAuthForIntent, intentDigest, computeMerchantId,
  randomBytes32, toWireRegistration, toWireInvoice, profileHash, erc20Abi,
} from '@scanpay/shared';

const chainId = Number(process.argv[2] ?? 10143);
const only = (process.argv[3] ?? 'all').toUpperCase();
const API = process.env.API_URL ?? 'http://127.0.0.1:8787';
const ADMIN = process.env.ADMIN_TOKEN!;
const dep = getDeployment(chainId);
const isMainnet = dep.network === 'mainnet';
const rpc = chainId === 143 ? process.env.MONAD_MAINNET_RPC! : chainId === 10143 ? process.env.MONAD_TESTNET_RPC! : process.env.LOCAL_RPC!;
const pub = createPublicClient({ transport: http(rpc) });
// A hand-rolled chain literal makes viem fall back to a transaction shape Monad's
// RPC rejects with "Missing or invalid parameters"; defineChain fills in the rest.
const chain = defineChain({
  id: chainId, name: dep.network,
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [rpc] } },
});

const usdc = dep.tokens.USDC!;
const AMOUNT = parseUnits(process.env.E2E_AMOUNT ?? (isMainnet ? '0.02' : '1.23'), usdc.decimals);
const now = () => BigInt(Math.floor(Date.now() / 1000));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (s: string) => console.log(s);

async function api(method: string, path: string, body?: unknown, admin = false) {
  const r = await fetch(`${API}${path}`, {
    method, headers: { 'content-type': 'application/json', ...(admin ? { authorization: `Bearer ${ADMIN}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text(); let j: any; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}\n${JSON.stringify(j, null, 2)}`);
  return j;
}

// payer: generated on testnet (faucet funds it); real wallet on mainnet
const payer = privateKeyToAccount((process.env.PAYER_PRIVATE_KEY as Hex) ?? generatePrivateKey());
const payerWallet = createWalletClient({ account: payer, chain, transport: http(rpc) });

async function newMerchant(label: string) {
  const owner = privateKeyToAccount(generatePrivateKey());
  const payout = privateKeyToAccount(generatePrivateKey());   // money lands here, not with the payer
  const signer = privateKeyToAccount(generatePrivateKey());
  const salt = randomBytes32();
  const profile = { displayName: label, category: 'cafe', city: 'Chennai', country: 'IN', logoUrl: '' };
  const reg = {
    owner: owner.address, salt, payoutWallet: payout.address, invoiceSigner: signer.address,
    payoutToken: usdc.address, metadataHash: profileHash(profile), nonce: 0n, deadline: now() + 3600n,
  };
  const td = buildRegistrationTypedData(chainId, dep.contracts.MerchantRegistry.address, reg);
  const res = await api('POST', '/v1/merchants/register', {
    chainId, registration: toWireRegistration(reg),
    ownerSig: await owner.signTypedData(td as any), payoutSig: await payout.signTypedData(td as any), profile,
  });
  const merchantId = computeMerchantId(owner.address, salt);
  if (!(res.autoApproved || res.status === 'ACTIVE')) await api('POST', `/v1/admin/merchants/${chainId}/${merchantId}/approve`, {}, true);
  console.log(`   merchant ${merchantId.slice(0, 10)}…  payout ${payout.address}`);
  if (process.env.E2E_DUMP_KEYS) console.log(`   payoutKey ${payout.source === 'privateKey' ? '' : ''}`);
  return { merchantId, signer, payout };
}

async function newInvoice(m: Awaited<ReturnType<typeof newMerchant>>) {
  const invoice = { merchantId: m.merchantId, invoiceId: randomBytes32(), payoutToken: usdc.address, amount: AMOUNT, expiresAt: now() + 1800n, keyVersion: 1 };
  const td = buildInvoiceTypedData(chainId, dep.contracts.IntentVault.address, invoice);
  const r = await api('POST', '/v1/invoices', { chainId, invoice: toWireInvoice(invoice), merchantSig: await m.signer.signTypedData(td as any), memo: 'flat white' });
  return r.shortCode as string;
}

const toBig = (i: any) => ({ ...i, amountOut: BigInt(i.amountOut), maxAmountIn: BigInt(i.maxAmountIn), expiresAt: BigInt(i.expiresAt), nonce: BigInt(i.nonce) });

async function verdictOf(intentId: string) {
  for (let i = 0; i < 25; i++) {
    const v = await api('GET', `/v1/verify/${chainId}/${intentId}`).catch(() => null);
    if (v?.verdict && v.verdict !== 'PENDING') return v;
    await sleep(3000);
  }
  return null;
}

function printVerdict(v: any) {
  if (!v) return say('   verdict: (none yet — follower still catching up)');
  say(`   VERDICT: ${v.verdict}`);
  for (const [g, grp] of Object.entries<any>(v.proofs)) {
    const bad = grp.checks.filter((c: any) => c.ok === false).map((c: any) => c.label);
    say(`     ${grp.ok ? 'ok  ' : 'FAIL'} ${g}${bad.length ? '  failed: ' + bad.join(', ') : ''}`);
  }
}

async function balances(addr: Address) {
  return (await pub.readContract({ address: usdc.address, abi: erc20Abi, functionName: 'balanceOf', args: [addr] })) as bigint;
}

async function runDirect() {
  say('\n════ DIRECT ════');
  const m = await newMerchant('Blue Bottle (direct)');
  const code = await newInvoice(m);
  const prep = await api('POST', '/v1/intents/prepare', { shortCode: code, route: 'DIRECT', payer: payer.address });
  const intent = toBig(prep.intent);
  const payerSig = await payer.signTypedData(buildIntentTypedData(chainId, dep.contracts.IntentVault.address, intent) as any);
  const digest = intentDigest(chainId, dep.contracts.IntentVault.address, intent);
  const authSig = await payer.signTypedData(buildReceiveAuthTypedData(chainId, usdc, receiveAuthForIntent(intent, digest, dep.contracts.IntentVault.address)) as any);
  const sub = await api('POST', '/v1/intents/submit', { draftId: prep.draftId, payerSig, receiveAuthSig: authSig });
  say(`   tx ${sub.txHash}   lifecycle ${sub.lifecycle}`);
  say(`   merchant received ${formatUnits(await balances(m.payout.address), usdc.decimals)} USDC`);
  printVerdict(await verdictOf(sub.intentId));
}

async function runSwap() {
  say('\n════ SWAP ════');
  const m = await newMerchant('Blue Bottle (swap)');
  const code = await newInvoice(m);
  const inputKey = isMainnet ? 'WMON' : 'MON';
  const prep = await api('POST', '/v1/intents/prepare', { shortCode: code, route: 'SWAP', inputTokenKey: inputKey, payer: payer.address });
  const intent = toBig(prep.intent);
  say(`   pays ${formatUnits(intent.maxAmountIn, dep.tokens[inputKey as 'MON']!.decimals)} ${inputKey} -> ${formatUnits(intent.amountOut, usdc.decimals)} USDC`);

  // one-time approve by the payer (operator drips the gas for it)
  const inTok = dep.tokens[inputKey as 'MON']!;
  const cur = (await pub.readContract({ address: inTok.address, abi: erc20Abi, functionName: 'allowance', args: [payer.address, dep.contracts.IntentVault.address] })) as bigint;
  if (cur < intent.maxAmountIn) {
    await api('POST', '/v1/gas/drip', { chainId, address: payer.address, tokenKey: inputKey }).catch((e) => say(`   (drip: ${String(e).slice(0, 60)})`));
    const h = await payerWallet.writeContract({
      address: inTok.address, abi: erc20Abi, functionName: 'approve',
      args: [dep.contracts.IntentVault.address, 2n ** 256n - 1n], chain, account: payer,
    });
    await pub.waitForTransactionReceipt({ hash: h });
    say(`   approved vault (${h})`);
  }
  const payerSig = await payer.signTypedData(buildIntentTypedData(chainId, dep.contracts.IntentVault.address, intent) as any);
  const sub = await api('POST', '/v1/intents/submit', { draftId: prep.draftId, payerSig });
  say(`   tx ${sub.txHash}   lifecycle ${sub.lifecycle}`);
  say(`   merchant received ${formatUnits(await balances(m.payout.address), usdc.decimals)} USDC`);
  printVerdict(await verdictOf(sub.intentId));
}

async function runCrossChain() {
  say('\n════ CROSSCHAIN ════');
  const m = await newMerchant('Blue Bottle (crosschain)');
  const code = await newInvoice(m);
  const prep = await api('POST', '/v1/intents/prepare', {
    shortCode: code, route: 'CROSSCHAIN', payer: payer.address,
    origin: { assetId: dep.external.auroraMonadUsdcAssetId ?? 'sim', refundTo: payer.address },
  });
  const intent = toBig(prep.intent);
  const payerSig = await payer.signTypedData(buildIntentTypedData(chainId, dep.contracts.IntentVault.address, intent) as any);
  const sub = await api('POST', '/v1/intents/submit', { draftId: prep.draftId, payerSig });
  say(`   commit tx ${sub.txHash}   forwarder ${sub.forwarder}`);
  say(`   deposit address ${sub.depositAddress ?? sub.forwarder}`);

  if (!isMainnet) {
    say('   simulating the solver deposit (testnet)…');
    await api('POST', `/v1/intents/${chainId}/${sub.intentId}/simulate-deposit`, {});
  } else {
    say(`   >>> send ${formatUnits(intent.amountOut, usdc.decimals)} USDC on the origin chain to ${sub.depositAddress ?? sub.forwarder}`);
  }
  for (let i = 0; i < 25; i++) {
    const st = await api('GET', `/v1/intents/${chainId}/${sub.intentId}`).catch(() => null);
    if (st?.lifecycle === 'SETTLED') { say(`   settled: ${st.txs?.settle ?? ''}`); break; }
    await sleep(3000);
  }
  say(`   merchant received ${formatUnits(await balances(m.payout.address), usdc.decimals)} USDC`);
  printVerdict(await verdictOf(sub.intentId));
}

say(`chain ${chainId} (${dep.network})  payer ${payer.address}  amount ${formatUnits(AMOUNT, usdc.decimals)} USDC`);
if (!isMainnet) { await api('POST', '/v1/faucet', { chainId, address: payer.address }).catch(() => {}); }
say(`payer USDC balance ${formatUnits(await balances(payer.address), usdc.decimals)}`);

if (only === 'ALL' || only === 'DIRECT') await runDirect();
if (only === 'ALL' || only === 'SWAP') await runSwap();
if (only === 'ALL' || only === 'CROSSCHAIN') await runCrossChain();
say('\ndone.');
