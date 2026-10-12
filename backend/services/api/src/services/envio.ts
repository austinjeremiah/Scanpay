import type { Hex } from 'viem';
import { log } from '../log.js';

let url: string | undefined;
export const setEnvioUrl = (u?: string) => (url = u);
export const envioEnabled = () => Boolean(url);

export async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  if (!url) throw new Error('envio disabled');
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(6000),
  });
  const j = (await r.json()) as { data?: T; errors?: { message: string }[] };
  if (!r.ok || j.errors?.length) {
    log.warn({ status: r.status, errors: j.errors }, 'envio query failed');
    throw new Error(j.errors?.[0]?.message ?? `envio ${r.status}`);
  }
  return j.data!;
}

export const eid = (chainId: number, hex: string) => `${chainId}_${hex.toLowerCase()}`;

export const Q1_MERCHANT = /* GraphQL */ `
query Merchant($id: String!) { Merchant(where: { id: { _eq: $id } }) {
  id chainId merchantId owner payoutWallet invoiceSigner payoutToken metadataHash status statusName keyVersion
  registeredAt registeredTx updatedAt paymentCount settledVolume netReceived feesPaid } }`;

export const Q2_MERCHANT_INTENTS = /* GraphQL */ `
query MerchantIntents($chainId: Int!, $merchantId: String!, $limit: Int!, $offset: Int!) {
  Intent(where: { chainId: { _eq: $chainId }, merchantId: { _eq: $merchantId } },
         order_by: { committedAt: desc }, limit: $limit, offset: $offset) {
    id intentId payer invoiceId route routeName status inputToken payoutToken amountOut fee netToMerchant
    inputAmount excessRefunded forwarder committedAt committedTx settledAt settledTx refundedAt refundTx
    sourceChainId sourceTxHash } }`;

export const Q3_INTENT = /* GraphQL */ `
query IntentById($id: String!) { Intent(where: { id: { _eq: $id } }) {
  id chainId intentId merchantId payer invoiceId route routeName status inputToken payoutToken amountOut fee
  netToMerchant inputAmount excessRefunded forwarder payoutWallet expiresAt quoteHash committedAt committedTx
  committedBlock settledAt settledTx settledBlock refundedAt refundTx refundTo refundAmount rescuedAmount
  sourceChainId sourceTxHash providerRef attester attestedTx
  merchant { merchantId status statusName keyVersion payoutWallet owner } } }`;

export const Q4_DAILY = /* GraphQL */ `
query MerchantDaily($chainId: Int!, $merchantId: String!, $since: numeric!) {
  MerchantDailyStat(where: { chainId: { _eq: $chainId }, merchantId: { _eq: $merchantId }, dayStart: { _gte: $since } },
                    order_by: { dayStart: asc }) { dayStart payments volume net } }`;

export const Q5_KEYS = /* GraphQL */ `
query MerchantKeys($id: String!) { MerchantKeyEvent(where: { merchant_id: { _eq: $id } }, order_by: { timestamp: asc }) {
  kind keyVersion invoiceSigner payoutWallet payoutToken fromStatus toStatus by timestamp txHash } }`;

export const Q6_STATS = /* GraphQL */ `
query Stats($chainId: String!) { ProtocolStat(where: { id: { _eq: $chainId } }) {
  merchants activeMerchants intents settled refunded volume fees crossChainSettled } }`;

export type EnvioIntent = {
  id: string; intentId: Hex; payer: Hex; invoiceId: Hex; route: number; routeName: string; status: string;
  inputToken: Hex; payoutToken: Hex; amountOut: string; fee: string | null; netToMerchant: string | null;
  inputAmount: string | null; committedAt: string; committedTx: Hex; settledAt: string | null; settledTx: Hex | null;
  sourceChainId: string | null; sourceTxHash: Hex | null;
};
