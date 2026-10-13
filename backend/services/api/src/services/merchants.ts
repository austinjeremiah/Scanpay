import type { Hex } from 'viem';
import {
  buildPayoutUpdateTypedData, buildRegistrationTypedData, buildSignerRotationTypedData, computeMerchantId,
  fromWirePayoutUpdate, fromWireRegistration, fromWireSignerRotation, merchantRegistryAbi, profileHash,
  MERCHANT_STATUS, MERCHANT_STATUS_NAME, type Profile,
} from '@scanpay/shared';
import { z } from 'zod';
import type { zPayoutReq, zRegisterReq, zRotateReq } from '@scanpay/shared';
import type { ChainCtx } from '../chains.js';
import { audit, Merchant } from '../db/models.js';
import { ApiError } from '../errors.js';
import { relay } from '../relayer.js';
import { nowSec } from '../util/time.js';
import { merchantView, readMerchant } from './views.js';
import { channel, publish } from '../bus.js';

async function ownerNonce(ctx: ChainCtx, owner: Hex): Promise<bigint> {
  return (await ctx.public.readContract({
    address: ctx.registry, abi: merchantRegistryAbi, functionName: 'ownerNonce', args: [owner],
  })) as bigint;
}

async function verify(ctx: ChainCtx, address: Hex, typedData: any, signature: Hex): Promise<boolean> {
  return ctx.public.verifyTypedData({ address, signature, ...typedData });
}

export async function registerMerchant(ctx: ChainCtx, req: z.infer<typeof zRegisterReq>) {
  const reg = fromWireRegistration(req.registration);
  if (profileHash(req.profile).toLowerCase() !== reg.metadataHash.toLowerCase()) throw new ApiError('PROFILE_HASH_MISMATCH');
  if (reg.deadline < BigInt(nowSec())) throw new ApiError('SIGNATURE_EXPIRED');
  if (!ctx.tokenByAddress(reg.payoutToken)?.token.roles.includes('payout')) throw new ApiError('PAYOUT_TOKEN_NOT_ALLOWED');
  const expected = await ownerNonce(ctx, reg.owner);
  if (expected !== reg.nonce) throw new ApiError('BAD_NONCE', undefined, { expected: expected.toString() });

  const td = buildRegistrationTypedData(ctx.chainId, ctx.registry, reg);
  if (!(await verify(ctx, reg.owner, td, req.ownerSig))) throw new ApiError('INVALID_OWNER_SIGNATURE');
  if (!(await verify(ctx, reg.payoutWallet, td, req.payoutSig))) throw new ApiError('INVALID_PAYOUT_SIGNATURE');

  const merchantId = computeMerchantId(reg.owner, reg.salt).toLowerCase() as Hex;
  const { hash, receipt } = await relay(ctx, {
    address: ctx.registry, abi: merchantRegistryAbi, functionName: 'registerMerchant',
    args: [reg, req.ownerSig, req.payoutSig], label: 'registerMerchant',
  });
  const block = await ctx.public.getBlock({ blockNumber: receipt.blockNumber });

  await Merchant.updateOne(
    { chainId: ctx.chainId, merchantId },
    {
      $set: {
        owner: reg.owner.toLowerCase(), salt: reg.salt.toLowerCase(), payoutWallet: reg.payoutWallet.toLowerCase(),
        invoiceSigner: reg.invoiceSigner.toLowerCase(), payoutToken: reg.payoutToken.toLowerCase(), keyVersion: 1,
        status: 'PENDING', metadataHash: reg.metadataHash.toLowerCase(), profile: req.profile as Profile,
        registeredAt: Number(block.timestamp), registeredTx: hash,
      },
    },
    { upsert: true },
  );
  await audit('relayer', 'merchant.register', ctx.chainId, merchantId, { txHash: hash, owner: reg.owner });

  let approveTxHash: Hex | null = null;
  let status: (typeof MERCHANT_STATUS_NAME)[number] = 'PENDING';
  const r = await setStatus(ctx, merchantId, MERCHANT_STATUS.ACTIVE, 'auto-approve');
  approveTxHash = r.txHash;
  status = 'ACTIVE';
  return { merchantId, txHash: hash, status, autoApproved: true, approveTxHash };
}

export async function setStatus(ctx: ChainCtx, merchantId: Hex, newStatus: number, reason: string) {
  const { hash } = await relay(ctx, {
    address: ctx.registry, abi: merchantRegistryAbi, functionName: 'setMerchantStatus',
    args: [merchantId, newStatus], label: `setMerchantStatus(${newStatus})`,
  });
  const name = MERCHANT_STATUS_NAME[newStatus];
  await Merchant.updateOne({ chainId: ctx.chainId, merchantId: merchantId.toLowerCase() }, { $set: { status: name } });
  await audit('admin', 'merchant.status', ctx.chainId, merchantId, { txHash: hash, status: name, reason });
  const view = await merchantView(ctx, merchantId);
  if (view) publish(channel.merchant(ctx.chainId, merchantId), { type: 'merchant.updated', merchant: view });
  return { txHash: hash, status: name };
}

export async function rotateSigner(ctx: ChainCtx, req: z.infer<typeof zRotateReq>) {
  const r = fromWireSignerRotation(req.rotation);
  const m = await readMerchant(ctx, r.merchantId);
  if (m.status === 0) throw new ApiError('MERCHANT_NOT_FOUND');
  if (m.status === MERCHANT_STATUS.REVOKED) throw new ApiError('MERCHANT_REVOKED');
  const expected = await ownerNonce(ctx, m.owner);
  if (expected !== r.nonce) throw new ApiError('BAD_NONCE', undefined, { expected: expected.toString() });
  const td = buildSignerRotationTypedData(ctx.chainId, ctx.registry, r);
  if (!(await verify(ctx, m.owner, td, req.ownerSig))) throw new ApiError('INVALID_OWNER_SIGNATURE');

  const { hash } = await relay(ctx, {
    address: ctx.registry, abi: merchantRegistryAbi, functionName: 'rotateInvoiceSigner',
    args: [r, req.ownerSig], label: 'rotateInvoiceSigner',
  });
  const after = await readMerchant(ctx, r.merchantId);
  await Merchant.updateOne(
    { chainId: ctx.chainId, merchantId: r.merchantId.toLowerCase() },
    { $set: { invoiceSigner: r.newSigner.toLowerCase(), keyVersion: Number(after.keyVersion) } },
  );
  await audit('relayer', 'merchant.rotate', ctx.chainId, r.merchantId, { txHash: hash, keyVersion: Number(after.keyVersion) });
  return { merchantId: r.merchantId.toLowerCase() as Hex, txHash: hash, keyVersion: Number(after.keyVersion) };
}

export async function updatePayout(ctx: ChainCtx, req: z.infer<typeof zPayoutReq>) {
  const u = fromWirePayoutUpdate(req.update);
  const m = await readMerchant(ctx, u.merchantId);
  if (m.status === 0) throw new ApiError('MERCHANT_NOT_FOUND');
  if (m.status === MERCHANT_STATUS.REVOKED) throw new ApiError('MERCHANT_REVOKED');
  const expected = await ownerNonce(ctx, m.owner);
  if (expected !== u.nonce) throw new ApiError('BAD_NONCE', undefined, { expected: expected.toString() });
  const td = buildPayoutUpdateTypedData(ctx.chainId, ctx.registry, u);
  if (!(await verify(ctx, m.owner, td, req.ownerSig))) throw new ApiError('INVALID_OWNER_SIGNATURE');
  if (!(await verify(ctx, u.payoutWallet, td, req.payoutSig))) throw new ApiError('INVALID_PAYOUT_SIGNATURE');

  const { hash } = await relay(ctx, {
    address: ctx.registry, abi: merchantRegistryAbi, functionName: 'updatePayout',
    args: [u, req.ownerSig, req.payoutSig], label: 'updatePayout',
  });
  const after = await readMerchant(ctx, u.merchantId);
  await Merchant.updateOne(
    { chainId: ctx.chainId, merchantId: u.merchantId.toLowerCase() },
    { $set: { payoutWallet: u.payoutWallet.toLowerCase(), payoutToken: u.payoutToken.toLowerCase(), keyVersion: Number(after.keyVersion) } },
  );
  await audit('relayer', 'merchant.payout', ctx.chainId, u.merchantId, { txHash: hash });
  return { merchantId: u.merchantId.toLowerCase() as Hex, txHash: hash, keyVersion: Number(after.keyVersion) };
}
