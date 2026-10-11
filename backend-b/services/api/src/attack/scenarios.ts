import type { Hex } from 'viem';
import {
  buildIntentTypedData, buildInvoiceTypedData, intentVaultAbi, merchantRegistryAbi,
  randomBytes32, randomNonce, computeIntentId,
  ROUTE, type PaymentIntentMessage, type InvoiceMessage,
} from '@scanpay/shared';
import type { ScenarioId, AttackResult, zScenarioInfo } from '@scanpay/shared';
import type { z } from 'zod';
import { chainCtx } from '../chains.js';
import { relay, broadcastExpectRevert } from '../relayer.js';
import { getLab, fundPayer, ensureMerchantRegistered, legitInvoice, legitIntent } from './lab.js';
import { nowSec } from '../util/time.js';

export const SCENARIO_INFO: z.infer<typeof zScenarioInfo>[] = [
  {
    id: 'tamper_amount', title: 'Amount Tamper', proofLayer: 'merchant',
    attack: 'Payer signs a lower amountOut than what the merchant signed in the invoice.',
    defense: 'Vault cross-checks invoice.amount == intent.amountOut; EIP-712 domain-binds both.',
    expectedError: 'InvalidAmount or signature mismatch',
  },
  {
    id: 'tamper_destination', title: 'Destination Tamper', proofLayer: 'merchant',
    attack: 'Payer replaces merchantId so funds go to a different merchant.',
    defense: 'MerchantId is bound in both invoice and intent EIP-712 structs.',
    expectedError: 'InvalidMerchant or bad signature',
  },
  {
    id: 'replay', title: 'Replay Attack', proofLayer: 'intent',
    attack: 'Attempt to submit the same intentId a second time.',
    defense: 'Vault stores intentId in a used-nonce set; second call reverts.',
    expectedError: 'IntentAlreadyCommitted',
  },
  {
    id: 'expired', title: 'Expired Intent', proofLayer: 'intent',
    attack: 'Submit an intent whose expiresAt is in the past.',
    defense: 'Vault checks block.timestamp <= expiresAt.',
    expectedError: 'IntentExpired',
  },
  {
    id: 'unregistered_qr', title: 'Unregistered Merchant QR', proofLayer: 'merchant',
    attack: 'Create a fake merchantId not in the registry and try to collect payment.',
    defense: 'Registry lookup fails; getMerchant reverts or returns status=NONE.',
    expectedError: 'MerchantNotFound or MerchantNotActive',
  },
  {
    id: 'fake_provider_success', title: 'Fake Provider Success', proofLayer: 'settlement',
    attack: 'Claim cross-chain bridge delivered funds without an actual on-chain transfer.',
    defense: 'Vault reads forwarder balance on-chain; refuses to settle if balance < required.',
    expectedError: 'InsufficientForwarderBalance',
  },
  {
    id: 'forged_settlement_hash', title: 'Forged Settlement Hash', proofLayer: 'settlement',
    attack: 'Forge an attestation tx hash to claim a cross-chain payment settled.',
    defense: 'Only the authorized oracle can call attestSource; non-operator calls revert.',
    expectedError: 'Unauthorized or access control revert',
  },
  {
    id: 'wrong_token', title: 'Wrong Input Token', proofLayer: 'intent',
    attack: 'Payer specifies an input token not in the allowed list to avoid paying.',
    defense: 'Vault rejects unrecognized swap adapters; quoteHash binds the token.',
    expectedError: 'TokenNotAllowed or AdapterNotFound',
  },
];

type ScenarioResult = Omit<AttackResult, 'durationMs'>;

async function run(chainId: number, id: ScenarioId, broadcast: boolean): Promise<ScenarioResult> {
  const ctx = chainCtx(chainId);
  const lab = await getLab(chainId);
  await ensureMerchantRegistered(lab);
  await fundPayer(lab);
  const info = SCENARIO_INFO.find((s) => s.id === id)!;

  switch (id) {
    case 'tamper_amount': {
      const { invoice, merchantSig } = await legitInvoice(lab);
      const { intent: legit, payerSig } = await legitIntent(lab, invoice);
      const tampered: PaymentIntentMessage = { ...legit, amountOut: legit.amountOut / 2n };
      const tamperedSig = await lab.payer.wallet.signTypedData({
        account: lab.payer.account,
        ...buildIntentTypedData(chainId, ctx.vault, tampered),
      } as any) as Hex;
      const { outcome, observed, txHash } = await broadcastExpectRevert(ctx, {
        address: ctx.vault, abi: intentVaultAbi, functionName: 'payDirect',
        args: [tampered, invoice, merchantSig, tamperedSig, { v: 27, r: randomBytes32(), s: randomBytes32() }],
        label: `attack:${id}`,
      }, broadcast);
      void payerSig;
      return { ...info, scenario: id, outcome, observed, txHash: txHash ?? null, explorerUrl: txHash ? ctx.explorerTx(txHash) : null };
    }

    case 'tamper_destination': {
      const { invoice, merchantSig } = await legitInvoice(lab);
      const { intent: legit, payerSig } = await legitIntent(lab, invoice);
      const fakeId = randomBytes32();
      const tampered: PaymentIntentMessage = { ...legit, merchantId: fakeId };
      const tamperedSig = await lab.payer.wallet.signTypedData({
        account: lab.payer.account,
        ...buildIntentTypedData(chainId, ctx.vault, tampered),
      } as any) as Hex;
      const { outcome, observed, txHash } = await broadcastExpectRevert(ctx, {
        address: ctx.vault, abi: intentVaultAbi, functionName: 'payDirect',
        args: [tampered, invoice, merchantSig, tamperedSig, { v: 27, r: randomBytes32(), s: randomBytes32() }],
        label: `attack:${id}`,
      }, broadcast);
      void payerSig;
      return { ...info, scenario: id, outcome, observed, txHash: txHash ?? null, explorerUrl: txHash ? ctx.explorerTx(txHash) : null };
    }

    case 'replay': {
      const { invoice, merchantSig } = await legitInvoice(lab);
      const { intent, payerSig } = await legitIntent(lab, invoice);
      // first call should succeed
      try {
        await relay(ctx, {
          address: ctx.vault, abi: intentVaultAbi, functionName: 'payDirect',
          args: [intent, invoice, merchantSig, payerSig, { v: 27, r: randomBytes32(), s: randomBytes32() }],
          label: 'replay-first',
        });
      } catch { /* may already be used */ }
      // second call: replay
      const { outcome, observed, txHash } = await broadcastExpectRevert(ctx, {
        address: ctx.vault, abi: intentVaultAbi, functionName: 'payDirect',
        args: [intent, invoice, merchantSig, payerSig, { v: 27, r: randomBytes32(), s: randomBytes32() }],
        label: `attack:${id}`,
      }, broadcast);
      return { ...info, scenario: id, outcome, observed, txHash: txHash ?? null, explorerUrl: txHash ? ctx.explorerTx(txHash) : null };
    }

    case 'expired': {
      const { invoice: inv, merchantSig } = await legitInvoice(lab);
      const expiredInvoice: InvoiceMessage = { ...inv, expiresAt: BigInt(nowSec() - 100) };
      const expiredIntent: PaymentIntentMessage = {
        merchantId: lab.merchantId, invoiceId: expiredInvoice.invoiceId, payer: lab.payer.account.address,
        payoutToken: expiredInvoice.payoutToken, amountOut: expiredInvoice.amount, route: ROUTE.DIRECT,
        inputToken: expiredInvoice.payoutToken, maxAmountIn: expiredInvoice.amount, quoteHash: randomBytes32(),
        refundTo: lab.payer.account.address, expiresAt: BigInt(nowSec() - 100), nonce: randomNonce(), keyVersion: 1,
      };
      const expiredInvoiceSig = await lab.merchant.wallet.signTypedData({
        account: lab.merchant.account,
        ...buildInvoiceTypedData(chainId, ctx.vault, expiredInvoice),
      } as any) as Hex;
      const expiredIntentSig = await lab.payer.wallet.signTypedData({
        account: lab.payer.account,
        ...buildIntentTypedData(chainId, ctx.vault, expiredIntent),
      } as any) as Hex;
      const { outcome, observed, txHash } = await broadcastExpectRevert(ctx, {
        address: ctx.vault, abi: intentVaultAbi, functionName: 'payDirect',
        args: [expiredIntent, expiredInvoice, expiredInvoiceSig, expiredIntentSig, { v: 27, r: randomBytes32(), s: randomBytes32() }],
        label: `attack:${id}`,
      }, broadcast);
      return { ...info, scenario: id, outcome, observed, txHash: txHash ?? null, explorerUrl: txHash ? ctx.explorerTx(txHash) : null };
    }

    case 'unregistered_qr': {
      const fakeMerchantId = randomBytes32();
      const fakeInvoice: InvoiceMessage = {
        merchantId: fakeMerchantId, invoiceId: randomBytes32(), payoutToken: lab.usdc,
        amount: 10n * 10n ** 6n, expiresAt: BigInt(nowSec() + 600), keyVersion: 1,
      };
      const fakeInvoiceSig = await lab.merchant.wallet.signTypedData({
        account: lab.merchant.account,
        ...buildInvoiceTypedData(chainId, ctx.vault, fakeInvoice),
      } as any) as Hex;
      const fakeIntent: PaymentIntentMessage = {
        merchantId: fakeMerchantId, invoiceId: fakeInvoice.invoiceId, payer: lab.payer.account.address,
        payoutToken: lab.usdc, amountOut: fakeInvoice.amount, route: ROUTE.DIRECT, inputToken: lab.usdc,
        maxAmountIn: fakeInvoice.amount, quoteHash: randomBytes32(), refundTo: lab.payer.account.address,
        expiresAt: BigInt(nowSec() + 600), nonce: randomNonce(), keyVersion: 1,
      };
      const fakeIntentSig = await lab.payer.wallet.signTypedData({
        account: lab.payer.account,
        ...buildIntentTypedData(chainId, ctx.vault, fakeIntent),
      } as any) as Hex;
      const { outcome, observed, txHash } = await broadcastExpectRevert(ctx, {
        address: ctx.vault, abi: intentVaultAbi, functionName: 'payDirect',
        args: [fakeIntent, fakeInvoice, fakeInvoiceSig, fakeIntentSig, { v: 27, r: randomBytes32(), s: randomBytes32() }],
        label: `attack:${id}`,
      }, broadcast);
      return { ...info, scenario: id, outcome, observed, txHash: txHash ?? null, explorerUrl: txHash ? ctx.explorerTx(txHash) : null };
    }

    case 'fake_provider_success': {
      const { invoice, merchantSig } = await legitInvoice(lab);
      // try to commit CC and then call settleCrossChain without actually delivering funds
      const { intent } = await legitIntent(lab, { ...invoice });
      const ccIntent: PaymentIntentMessage = { ...intent, route: ROUTE.CROSSCHAIN };
      const ccIntentSig = await lab.payer.wallet.signTypedData({
        account: lab.payer.account,
        ...buildIntentTypedData(chainId, ctx.vault, ccIntent),
      } as any) as Hex;
      let committed = false;
      try {
        await relay(ctx, {
          address: ctx.vault, abi: intentVaultAbi, functionName: 'commitCrossChain',
          args: [ccIntent, invoice, merchantSig, ccIntentSig], label: 'fake-provider-commit',
        });
        committed = true;
      } catch { /* not available */ }
      const ccIntentId = computeIntentId(ccIntent);
      const { outcome, observed, txHash } = await broadcastExpectRevert(ctx, {
        address: ctx.vault, abi: intentVaultAbi, functionName: 'settleCrossChain',
        args: [ccIntentId, '0x'], label: `attack:${id}`,
      }, broadcast);
      void committed;
      return { ...info, scenario: id, outcome, observed, txHash: txHash ?? null, explorerUrl: txHash ? ctx.explorerTx(txHash) : null };
    }

    case 'forged_settlement_hash': {
      const { intent } = await legitIntent(lab, (await legitInvoice(lab)).invoice);
      const fakeIntentId = computeIntentId(intent);
      const { outcome, observed, txHash } = await broadcastExpectRevert(ctx, {
        address: ctx.vault, abi: intentVaultAbi, functionName: 'attestSource',
        args: [fakeIntentId, 1n, randomBytes32(), randomBytes32()], label: `attack:${id}`,
      }, broadcast);
      return { ...info, scenario: id, outcome, observed, txHash: txHash ?? null, explorerUrl: txHash ? ctx.explorerTx(txHash) : null };
    }

    case 'wrong_token': {
      const { invoice, merchantSig } = await legitInvoice(lab);
      const fakeToken = '0x' + 'deadbeef'.padEnd(40, '0') as Hex;
      const badIntent: PaymentIntentMessage = {
        ...( await legitIntent(lab, invoice)).intent,
        inputToken: fakeToken,
      };
      const badIntentSig = await lab.payer.wallet.signTypedData({
        account: lab.payer.account,
        ...buildIntentTypedData(chainId, ctx.vault, badIntent),
      } as any) as Hex;
      const { outcome, observed, txHash } = await broadcastExpectRevert(ctx, {
        address: ctx.vault, abi: intentVaultAbi, functionName: 'paySwap',
        args: [badIntent, invoice, merchantSig, badIntentSig, '0x'], label: `attack:${id}`,
      }, broadcast);
      return { ...info, scenario: id, outcome, observed, txHash: txHash ?? null, explorerUrl: txHash ? ctx.explorerTx(txHash) : null };
    }

    default:
      throw new Error(`Unknown scenario: ${id}`);
  }
}

export async function runScenario(chainId: number, id: ScenarioId, broadcast: boolean): Promise<AttackResult> {
  const start = Date.now();
  const result = await run(chainId, id, broadcast);
  return { ...result, durationMs: Date.now() - start };
}
