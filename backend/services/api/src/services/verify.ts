import type { Hex } from 'viem';
import {
  buildInvoiceTypedData, buildIntentTypedData, intentVaultAbi, merchantRegistryAbi,
  intentDigest, quoteHash as computeQuoteHash, INTENT_STATUS, fromWireIntent, fromWireInvoice,
} from '@scanpay/shared';
import { chainCtx } from '../chains.js';
import { Intent, type IntentDoc } from '../db/models.js';
import { ApiError } from '../errors.js';
import type { VerifyRes } from '@scanpay/shared';

type Check = { label: string; ok: boolean | null; detail: string };

function check(label: string, ok: boolean | null, detail: string): Check { return { label, ok, detail }; }

export async function verifyIntent(chainId: number, intentId: Hex): Promise<VerifyRes> {
  const ctx = chainCtx(chainId);
  const d = (await Intent.findOne({ chainId, intentId: intentId.toLowerCase() }).lean()) as IntentDoc | null;

  if (!d) {
    return {
      chainId, intentId, verdict: 'NOT_FOUND',
      proofs: { merchant: { ok: null, checks: [] }, intent: { ok: null, checks: [] }, settlement: { ok: null, checks: [] } },
      links: { commitTx: null, settleTx: null, vault: ctx.explorerAddress(ctx.vault) ?? ctx.vault, registry: ctx.explorerAddress(ctx.registry) ?? ctx.registry },
      trustNotes: ['Intent not found in local DB — it may not have been prepared through this backend.'],
    };
  }

  const intent = fromWireIntent(d.intent as any);
  const invoice = fromWireInvoice(d.invoice as any);
  const merchantChecks: Check[] = [];
  const intentChecks: Check[] = [];
  const settlementChecks: Check[] = [];

  // ── Merchant proof ────────────────────────────────────────────────────────
  let merchantOnchain: any;
  try {
    merchantOnchain = await ctx.public.readContract({ address: ctx.registry, abi: merchantRegistryAbi, functionName: 'getMerchant', args: [invoice.merchantId] });
    merchantChecks.push(check('merchant_registered', true, `merchant registered on-chain, status=${merchantOnchain.status}`));
    merchantChecks.push(check('merchant_active', merchantOnchain.status === 2, `status=${merchantOnchain.status} (2=ACTIVE)`));
    merchantChecks.push(check('key_version_matches', merchantOnchain.keyVersion === invoice.keyVersion, `on-chain=${merchantOnchain.keyVersion} invoice=${invoice.keyVersion}`));
  } catch {
    merchantChecks.push(check('merchant_registered', false, 'readContract failed — contract unreachable or merchant not found'));
  }

  // Verify merchant invoice signature off-chain
  if (merchantOnchain?.invoiceSigner) {
    try {
      const ok = await ctx.public.verifyTypedData({
        address: merchantOnchain.invoiceSigner, signature: d.merchantSig as Hex,
        ...buildInvoiceTypedData(chainId, ctx.registry, invoice),
      } as any);
      merchantChecks.push(check('merchant_sig', ok, ok ? 'merchant signature valid' : 'merchant signature INVALID'));
    } catch (e) {
      merchantChecks.push(check('merchant_sig', null, `signature verify error: ${(e as Error).message}`));
    }
  }

  // ── Intent proof ─────────────────────────────────────────────────────────
  // Verify payer sig
  if (d.payerSig) {
    try {
      const ok = await ctx.public.verifyTypedData({
        address: intent.payer, signature: d.payerSig as Hex,
        ...buildIntentTypedData(chainId, ctx.vault, intent),
      } as any);
      intentChecks.push(check('payer_sig', ok, ok ? 'payer signature valid' : 'payer signature INVALID'));
    } catch (e) {
      intentChecks.push(check('payer_sig', null, `${(e as Error).message}`));
    }
  } else {
    intentChecks.push(check('payer_sig', null, 'not yet submitted'));
  }

  // Verify quote hash matches stored quote
  if (d.quote) {
    try {
      const expected = computeQuoteHash(d.quote.fields as any);
      const match = expected.toLowerCase() === intent.quoteHash.toLowerCase();
      intentChecks.push(check('quote_hash', match, match ? 'quoteHash matches fields' : `expected=${expected} got=${intent.quoteHash}`));
    } catch {
      intentChecks.push(check('quote_hash', null, 'could not recompute'));
    }
  } else {
    intentChecks.push(check('quote_hash', null, 'no stored quote (DIRECT route)'));
  }

  // On-chain intent state
  let onchainIntent: any;
  try {
    onchainIntent = await ctx.public.readContract({ address: ctx.vault, abi: intentVaultAbi, functionName: 'getIntent', args: [intentId] });
    const statusName = ['NONE', 'COMMITTED', 'SETTLED', 'REFUNDED'][onchainIntent.status] ?? 'UNKNOWN';
    intentChecks.push(check('on_chain_status', onchainIntent.status > 0, `on-chain status=${statusName} (${onchainIntent.status})`));
    const amountMatch = BigInt(onchainIntent.amountOut) === intent.amountOut;
    intentChecks.push(check('amount_matches', amountMatch, `on-chain=${onchainIntent.amountOut} expected=${intent.amountOut}`));
  } catch {
    intentChecks.push(check('on_chain_status', null, 'getIntent failed — not committed or contract unreachable'));
  }

  // Intent digest consistency
  try {
    const computed = intentDigest(chainId, ctx.vault, intent);
    const stored = intentId;
    const match = computed.toLowerCase() === stored.toLowerCase();
    intentChecks.push(check('intent_digest', match, match ? 'intentId = keccak256(ABI-encoded intent)' : `computed=${computed} stored=${stored}`));
  } catch (e) {
    intentChecks.push(check('intent_digest', null, `${(e as Error).message}`));
  }

  // ── Settlement proof ─────────────────────────────────────────────────────
  if (d.lifecycle === 'SETTLED') {
    const settledOnChain = onchainIntent?.status === INTENT_STATUS.SETTLED;
    settlementChecks.push(check('settled_on_chain', settledOnChain, settledOnChain ? 'PaymentSettled event confirmed' : 'status not SETTLED on-chain'));
    if (d.onchain) {
      settlementChecks.push(check('fee_recorded', d.onchain.fee !== null, `fee=${d.onchain.fee}`));
      settlementChecks.push(check('net_to_merchant', d.onchain.netToMerchant !== null, `net=${d.onchain.netToMerchant}`));
    }
  } else if (d.lifecycle === 'REFUNDED') {
    settlementChecks.push(check('refunded_on_chain', onchainIntent?.status === INTENT_STATUS.REFUNDED, `lifecycle=REFUNDED`));
  } else {
    settlementChecks.push(check('settlement_pending', null, `lifecycle=${d.lifecycle}`));
  }

  const merchantOk = merchantChecks.every((c) => c.ok !== false);
  const intentOk = intentChecks.every((c) => c.ok !== false);
  const settlementOk = d.lifecycle === 'SETTLED' && settlementChecks.every((c) => c.ok !== false);

  const verdict: VerifyRes['verdict'] =
    d.lifecycle === 'REFUNDED' ? 'REFUNDED' :
    d.lifecycle === 'FAILED' ? 'FAILED' :
    d.lifecycle !== 'SETTLED' ? 'PENDING' :
    merchantOk && intentOk && settlementOk ? 'VERIFIED' : 'FAILED';

  const trustNotes: string[] = [
    'Signatures verified off-chain using viem verifyTypedData.',
    'On-chain state read via JSON-RPC at time of request — not a receipt.',
  ];
  if (d.quote?.simulated) trustNotes.push('Cross-chain route used a simulated solver — not a real bridge.');

  return {
    chainId, intentId, verdict,
    proofs: {
      merchant: { ok: merchantOk, checks: merchantChecks },
      intent: { ok: intentOk, checks: intentChecks },
      settlement: { ok: d.lifecycle === 'SETTLED' ? settlementOk : null, checks: settlementChecks },
    },
    links: {
      commitTx: d.txs?.commit ? ctx.explorerTx(d.txs.commit as Hex) : null,
      settleTx: d.txs?.settle ? ctx.explorerTx(d.txs.settle as Hex) : null,
      vault: ctx.explorerAddress(ctx.vault) ?? ctx.vault,
      registry: ctx.explorerAddress(ctx.registry) ?? ctx.registry,
    },
    trustNotes,
  };
}
