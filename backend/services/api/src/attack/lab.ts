import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex, WalletClient } from 'viem';
import {
  mockStableTokenAbi, erc20Abi, merchantRegistryAbi, intentVaultAbi,
  buildRegistrationTypedData, buildInvoiceTypedData, buildIntentTypedData,
  computeMerchantId, computeIntentId, randomBytes32, randomNonce,
  fromWireIntent, fromWireInvoice, toWireIntent, toWireInvoice,
  ROUTE, type PaymentIntentMessage, type InvoiceMessage, type RegistrationMessage,
} from '@scanpay/shared';
import { chainCtx, type ChainCtx } from '../chains.js';
import { relay, sendNative } from '../relayer.js';
import { LabState } from '../db/models.js';
import { nowSec } from '../util/time.js';

export interface Lab {
  chainId: number;
  ctx: ChainCtx;
  merchant: { account: ReturnType<typeof privateKeyToAccount>; wallet: WalletClient };
  payer: { account: ReturnType<typeof privateKeyToAccount>; wallet: WalletClient };
  merchantId: Hex;
  usdc: Address;
}

const labCache = new Map<number, Lab>();

export async function getLab(chainId: number): Promise<Lab> {
  if (labCache.has(chainId)) return labCache.get(chainId)!;
  const ctx = chainCtx(chainId);
  if (!ctx.features.attackLab) throw new Error('Attack lab not enabled on this chain');

  // load or create deterministic keys from DB
  let state = await LabState.findOne({ chainId }).lean();
  if (!state) {
    state = await LabState.create({
      chainId, merchantKey: generatePrivateKey(), payerKey: generatePrivateKey(),
    });
  }

  const merchantAcc = privateKeyToAccount(state.merchantKey as Hex);
  const payerAcc = privateKeyToAccount(state.payerKey as Hex);

  const merchantWallet = ctx.walletFrom(merchantAcc);
  const payerWallet = ctx.walletFrom(payerAcc);

  const usdcToken = ctx.token('USDC') ?? ctx.token('AUSD');
  if (!usdcToken) throw new Error('No stable token for lab');
  const usdc = usdcToken.address;

  const lab: Lab = { chainId, ctx, merchant: { account: merchantAcc, wallet: merchantWallet as any }, payer: { account: payerAcc, wallet: payerWallet as any }, merchantId: '0x', usdc };

  const salt = state.merchantSalt ? (state.merchantSalt as Hex) : randomBytes32();
  const merchantId = computeMerchantId(merchantAcc.address, salt);
  lab.merchantId = merchantId;
  labCache.set(chainId, lab);
  return lab;
}

export async function fundPayer(lab: Lab, tokenAmount = 1_000n * 10n ** 6n) {
  const ctx = lab.ctx;
  const address = lab.payer.account.address;
  const need = 5n * 10n ** 16n;
  if ((await ctx.public.getBalance({ address })) < need) await sendNative(ctx, address, need, 'lab-fund');
  await relay(ctx, { address: lab.usdc, abi: mockStableTokenAbi, functionName: 'mint', args: [address, tokenAmount], label: 'lab mint' });
  // approve vault
  const currentAllowance = (await ctx.public.readContract({ address: lab.usdc, abi: erc20Abi, functionName: 'allowance', args: [address, ctx.vault] })) as bigint;
  if (currentAllowance < tokenAmount) {
    await lab.payer.wallet.writeContract({
      chain: ctx.chain, account: lab.payer.account, address: lab.usdc, abi: erc20Abi,
      functionName: 'approve', args: [ctx.vault, tokenAmount * 10n],
    });
  }
}

export async function ensureMerchantRegistered(lab: Lab) {
  const ctx = lab.ctx;
  try {
    const m = await ctx.public.readContract({ address: ctx.registry, abi: merchantRegistryAbi, functionName: 'getMerchant', args: [lab.merchantId] });
    if ((m as any).status > 0) return;
  } catch { /* not registered */ }

  const state = await LabState.findOne({ chainId: lab.chainId }).lean();
  const salt = state?.merchantSalt ? (state.merchantSalt as Hex) : randomBytes32();
  if (!state?.merchantSalt) await LabState.updateOne({ chainId: lab.chainId }, { $set: { merchantSalt: salt } });

  const nonce = (await ctx.public.readContract({ address: ctx.registry, abi: merchantRegistryAbi, functionName: 'ownerNonce', args: [lab.merchant.account.address] })) as bigint;
  const payoutToken = lab.usdc;
  const msg: RegistrationMessage = {
    owner: lab.merchant.account.address,
    salt,
    payoutWallet: lab.merchant.account.address,
    invoiceSigner: lab.merchant.account.address,
    payoutToken,
    metadataHash: randomBytes32(),
    nonce,
    deadline: BigInt(nowSec() + 3600),
  };
  const typedData = buildRegistrationTypedData(lab.chainId, ctx.registry, msg);
  const ownerSig = await lab.merchant.wallet.signTypedData({ account: lab.merchant.account, ...typedData } as any);
  await relay(ctx, {
    address: ctx.registry, abi: merchantRegistryAbi, functionName: 'registerMerchant',
    args: [{ ...msg }, ownerSig, ownerSig], label: 'lab register',
  });
  // auto-approve
  await relay(ctx, { address: ctx.registry, abi: merchantRegistryAbi, functionName: 'setMerchantStatus', args: [lab.merchantId, 2], label: 'lab approve' });
}

export async function legitInvoice(lab: Lab): Promise<{ invoice: InvoiceMessage; merchantSig: Hex }> {
  const ctx = lab.ctx;
  const payoutToken = (ctx.token('USDC') ?? ctx.token('AUSD'))!.address;
  const invoiceId = randomBytes32();
  const invoice: InvoiceMessage = {
    merchantId: lab.merchantId,
    invoiceId,
    payoutToken,
    amount: 10n * 10n ** 6n,
    expiresAt: BigInt(nowSec() + 600),
    keyVersion: 1,
  };
  const sig = await lab.merchant.wallet.signTypedData({
    account: lab.merchant.account,
    ...buildInvoiceTypedData(lab.chainId, ctx.vault, invoice),
  } as any);
  return { invoice, merchantSig: sig as Hex };
}

export async function legitIntent(lab: Lab, invoice: InvoiceMessage): Promise<{ intent: PaymentIntentMessage; payerSig: Hex }> {
  const ctx = lab.ctx;
  const intent: PaymentIntentMessage = {
    merchantId: lab.merchantId,
    invoiceId: invoice.invoiceId,
    payer: lab.payer.account.address,
    payoutToken: invoice.payoutToken,
    amountOut: invoice.amount,
    route: ROUTE.DIRECT,
    inputToken: invoice.payoutToken,
    maxAmountIn: invoice.amount,
    quoteHash: randomBytes32(),
    refundTo: lab.payer.account.address,
    expiresAt: BigInt(nowSec() + 600),
    nonce: randomNonce(),
    keyVersion: 1,
  };
  const sig = await lab.payer.wallet.signTypedData({
    account: lab.payer.account,
    ...buildIntentTypedData(lab.chainId, ctx.vault, intent),
  } as any);
  return { intent, payerSig: sig as Hex };
}
