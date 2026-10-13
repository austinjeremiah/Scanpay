import type { ZodTypeAny, z } from 'zod';
import {
  zAdminActionRes, zAllowanceRes, zAttackResult, zConfigRes, zDripRes, zFaucetRes, zFxRes, zInvoiceCreatedRes,
  zInvoiceListRes, zInvoiceRequestListRes, zInvoiceRequestRes, zInvoiceView, zIntentView, zKeyChangeRes, zKeyEventsRes,
  zMerchantView, zMerchantsRes, zPaymentsRes, zPrepareRes, zProtocolStatsRes, zQrResolveRes, zQuoteRes, zRegisterRes,
  zRoutesRes, zScenariosRes, zStatsRes, zSubmitRes, zTxRes, zVerifyRes,
  type zCreateInvoiceReq, type zInvoiceRequestReq, type zPayoutReq, type zPrepareReq, type zQuoteReq, type zRegisterReq,
  type zRotateReq, type zSubmitReq, type ScenarioId,
} from './shared';
import { ENV } from './env';

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public details?: unknown,
    public requestId?: string,
  ) {
    super(message);
  }
}

async function call<S extends ZodTypeAny>(
  method: 'GET' | 'POST',
  path: string,
  schema: S | null,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<z.infer<S>> {
  let r: Response;
  try {
    r = await fetch(`${ENV.API_URL}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('NETWORK', 'No connection. Check your internet and try again.', 0);
  }
  const text = await r.text();
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError('INTERNAL', 'Unexpected response from ScanPay. Try again.', r.status);
  }
  if (!r.ok) {
    const e = json.error ?? {};
    throw new ApiError(e.code ?? 'INTERNAL', e.message ?? 'Something went wrong.', r.status, e.details, e.requestId);
  }
  return schema ? schema.parse(json) : json;
}

const q = (o: Record<string, string | number | undefined>) =>
  '?' + Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');

export const api = {
  // config + fx
  config: () => call('GET', '/v1/config', zConfigRes),
  fx: (quote: string) => call('GET', `/v1/fx${q({ quote })}`, zFxRes),
  stats: (chainId: number) => call('GET', `/v1/stats/${chainId}`, zProtocolStatsRes),

  // merchants
  registerMerchant: (b: z.input<typeof zRegisterReq>) => call('POST', '/v1/merchants/register', zRegisterRes, b),
  rotateSigner: (b: z.input<typeof zRotateReq>) => call('POST', '/v1/merchants/rotate-signer', zKeyChangeRes, b),
  updatePayout: (b: z.input<typeof zPayoutReq>) => call('POST', '/v1/merchants/update-payout', zKeyChangeRes, b),
  merchant: (chainId: number, id: string) => call('GET', `/v1/merchants/${chainId}/${id}`, zMerchantView),
  merchantsByOwner: (chainId: number, owner: string) => call('GET', `/v1/merchants/by-owner/${chainId}/${owner}`, zMerchantsRes),
  merchantPayments: (chainId: number, id: string, limit = 25, offset = 0) =>
    call('GET', `/v1/merchants/${chainId}/${id}/payments${q({ limit, offset })}`, zPaymentsRes),
  merchantStats: (chainId: number, id: string, days = 14) => call('GET', `/v1/merchants/${chainId}/${id}/stats${q({ days })}`, zStatsRes),
  merchantKeys: (chainId: number, id: string) => call('GET', `/v1/merchants/${chainId}/${id}/keys`, zKeyEventsRes),
  merchantInvoices: (chainId: number, id: string) => call('GET', `/v1/merchants/${chainId}/${id}/invoices`, zInvoiceListRes),
  merchantRequests: (chainId: number, id: string) => call('GET', `/v1/merchants/${chainId}/${id}/invoice-requests`, zInvoiceRequestListRes),

  // invoices + QR
  createInvoice: (b: z.input<typeof zCreateInvoiceReq>) => call('POST', '/v1/invoices', zInvoiceCreatedRes, b),
  invoice: (code: string) => call('GET', `/v1/invoices/${code}`, zInvoiceView),
  createInvoiceRequest: (b: z.input<typeof zInvoiceRequestReq>) => call('POST', '/v1/invoice-requests', zInvoiceRequestRes, b),
  invoiceRequest: (id: string) => call('GET', `/v1/invoice-requests/${id}`, zInvoiceRequestRes),
  qrResolve: (data: string) => call('GET', `/v1/qr/resolve${q({ data })}`, zQrResolveRes),

  // paying
  routes: (shortCode: string) => call('GET', `/v1/routes${q({ shortCode })}`, zRoutesRes),
  quote: (b: z.input<typeof zQuoteReq>) => call('POST', '/v1/quotes', zQuoteRes, b),
  prepare: (b: z.input<typeof zPrepareReq>) => call('POST', '/v1/intents/prepare', zPrepareRes, b),
  submit: (b: z.input<typeof zSubmitReq>) => call('POST', '/v1/intents/submit', zSubmitRes, b, { 'idempotency-key': b.draftId }),
  intent: (chainId: number, id: string) => call('GET', `/v1/intents/${chainId}/${id}`, zIntentView),
  sourceTx: (chainId: number, id: string, txHash: string) => call('POST', `/v1/intents/${chainId}/${id}/source-tx`, null, { txHash }),
  simulateDeposit: (chainId: number, id: string, amount?: string) =>
    call('POST', `/v1/intents/${chainId}/${id}/simulate-deposit`, zTxRes, amount ? { amount } : {}),
  verify: (chainId: number, id: string) => call('GET', `/v1/verify/${chainId}/${id}`, zVerifyRes),

  // account helpers
  allowance: (chainId: number, token: string, owner: string) => call('GET', `/v1/allowance${q({ chainId, token, owner })}`, zAllowanceRes),
  drip: (chainId: number, address: string, tokenKey: string) => call('POST', '/v1/gas/drip', zDripRes, { chainId, address, tokenKey }),
  faucet: (chainId: number, address: string) => call('POST', '/v1/faucet', zFaucetRes, { chainId, address }),

  // attack lab
  attackScenarios: () => call('GET', '/v1/attack/scenarios', zScenariosRes),
  attackRun: (chainId: number, scenario: ScenarioId, broadcast = false) =>
    call('POST', '/v1/attack/run', zAttackResult, { chainId, scenario, broadcast }),

  // admin (token from the Admin page input, kept in sessionStorage)
  adminMerchants: (token: string, chainId: number, status?: string) =>
    call('GET', `/v1/admin/merchants${q({ chainId, status })}`, zMerchantsRes, undefined, { authorization: `Bearer ${token}` }),
  adminAction: (token: string, chainId: number, merchantId: string, action: 'approve' | 'reactivate' | 'suspend' | 'revoke') =>
    call('POST', `/v1/admin/merchants/${chainId}/${merchantId}/${action}`, zAdminActionRes, {}, { authorization: `Bearer ${token}` }),
};

/** Live-update stream paths served by the API (SSE). */
export const streams = {
  intent: (chainId: number, intentId: string) => `/v1/stream/intent/${chainId}/${intentId}`,
  merchant: (chainId: number, merchantId: string) => `/v1/stream/merchant/${chainId}/${merchantId}`,
  invoice: (shortCode: string) => `/v1/stream/invoice/${shortCode}`,
  invoiceRequest: (requestId: string) => `/v1/stream/invoice-request/${requestId}`,
};
