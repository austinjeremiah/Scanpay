/**
 * Integration tests for all API endpoints.
 * Uses mongodb-memory-server (in-process MongoDB) and vi.mock for chain RPCs.
 * No Anvil, no real chain, no real MongoDB needed.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { getDeployment } from '@scanpay/shared';
import { connectDb } from '../../src/db/connect.js';
import { buildApp } from '../../src/http/app.js';
import type { Env } from '../../src/env.js';

// ─── hoisted mocks (available inside vi.mock factory) ────────────────────────

const { mockPublicClient, mockWalletClient, mockCtx } = vi.hoisted(() => {
  const mockPublicClient = {
    getBlockNumber: vi.fn().mockResolvedValue(100n),
    getBalance: vi.fn().mockResolvedValue(1_000_000_000_000_000_000n),
    readContract: vi.fn().mockImplementation(({ functionName }: { functionName: string }) => {
      switch (functionName) {
        case 'ownerNonce': return Promise.resolve(0n);
        case 'allowance': return Promise.resolve(1_000_000_000n);
        case 'balanceOf': return Promise.resolve(1_000_000_000n);
        case 'amountCap': return Promise.resolve(0n);
        case 'invoiceState': return Promise.resolve(0);
        // getMerchant: status=0 means unregistered — merchantView returns null → 404
        case 'getMerchant': return Promise.resolve({
          owner: '0x0000000000000000000000000000000000000000', salt: '0x' + '00'.repeat(32),
          payoutWallet: '0x0000000000000000000000000000000000000000', invoiceSigner: '0x0000000000000000000000000000000000000000',
          payoutToken: '0x0000000000000000000000000000000000000000', metadataHash: '0x' + '00'.repeat(32),
          status: 0, keyVersion: 0, registeredAt: 0n,
        });
        default: return Promise.reject(new Error(`readContract:${functionName} not stubbed`));
      }
    }),
    verifyTypedData: vi.fn().mockResolvedValue(true),
    simulateContract: vi.fn().mockResolvedValue({ request: {}, result: undefined }),
    estimateContractGas: vi.fn().mockResolvedValue(100_000n),
    waitForTransactionReceipt: vi.fn().mockResolvedValue({
      status: 'success', blockNumber: 101n,
      transactionHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    }),
    getBlock: vi.fn().mockResolvedValue({ timestamp: 1_700_000_000n }),
  };

  const mockWalletClient = {
    writeContract: vi.fn().mockResolvedValue('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
    account: { address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' },
  };

  // Build dep inline (can't import @scanpay/shared here — hoisted context)
  const LOCAL_VAULT = '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512';
  const LOCAL_REGISTRY = '0x5fbdb2315678afecb367f032d93f642f64180aa3';
  const LOCAL_ADAPTER = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0';
  const LOCAL_USDC = '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9';

  const mockCtx = {
    chainId: 31337,
    chain: { id: 31337, name: 'Foundry', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['http://127.0.0.1:8545'] } } },
    isMainnet: false,
    public: mockPublicClient,
    wallet: mockWalletClient,
    operator: { address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' },
    vault: LOCAL_VAULT,
    registry: LOCAL_REGISTRY,
    adapter: LOCAL_ADAPTER,
    adapterKind: 'mock',
    deployment: {
      contracts: {
        MerchantRegistry: { address: LOCAL_REGISTRY },
        IntentVault: { address: LOCAL_VAULT },
        MockSwapAdapter: { address: LOCAL_ADAPTER },
      },
      tokens: {
        USDC: { address: LOCAL_USDC, decimals: 6, symbol: 'USDC', roles: ['direct', 'payout', 'swapIn'], supports3009: true, isMock: true, usdPrice: 1, eip712: { name: 'ScanPay Test USDC', version: '1' } },
        AUSD: { address: '0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9', decimals: 6, symbol: 'AUSD', roles: ['payout', 'swapIn'], supports3009: false, isMock: true, usdPrice: 1 },
        MON: { address: '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707', decimals: 18, symbol: 'MON', roles: ['swapIn'], supports3009: false, isMock: true, usdPrice: 0.025 },
      },
      config: { feeBps: 30, refundDelaySec: 3600, crossChainInputToken: 'USDC' },
      features: { direct: true, swap: true, crosschain: 'simulated', faucet: true, attackLab: true, indexer: false },
      external: { kuruTargets: [] },
      startBlock: 1,
    },
    features: { direct: true, swap: true, crosschain: 'simulated', faucet: true, attackLab: true, indexer: false },
    token: (key: string) => (mockCtx as any).deployment.tokens[key],
    tokenByAddress: (addr: string) => {
      const lc = addr.toLowerCase();
      for (const [k, t] of Object.entries((mockCtx as any).deployment.tokens) as any[]) {
        if ((t as any).address.toLowerCase() === lc) return { key: k, token: t };
      }
      return undefined;
    },
    walletFrom: vi.fn().mockReturnValue(mockWalletClient),
    explorerTx: () => null,
    explorerAddress: () => null,
  };

  return { mockPublicClient, mockWalletClient, mockCtx };
});

// ─── module mocks ─────────────────────────────────────────────────────────────

vi.mock('../../src/chains.js', () => ({
  initChains: vi.fn(),
  chainCtx: vi.fn().mockImplementation((id: number) => {
    if (id === 31337) return mockCtx;
    throw new Error(`Chain ${id} not enabled`);
  }),
  allChains: vi.fn().mockReturnValue([mockCtx]),
}));

vi.mock('../../src/worker/index.js', () => ({
  startWorker: vi.fn(),
  stopWorker: vi.fn(),
}));

// ─── constants (post-hoist, safe to use getDeployment here) ──────────────────

const dep = getDeployment(31337);

const TEST_ADMIN_TOKEN = 'test-admin-token-32chars-minimum!!';
const testEnv: Env = {
  NODE_ENV: 'test',
  PORT: 0,
  PUBLIC_APP_URL: 'http://localhost:3000',
  CORS_ORIGINS: 'http://localhost:3000',
  ENABLED_CHAINS: [31337],
  MONGODB_URI: '', // filled in beforeAll
  MONAD_TESTNET_RPC: 'http://127.0.0.1:8545',
  MONAD_MAINNET_RPC: 'http://127.0.0.1:8545',
  LOCAL_RPC: 'http://127.0.0.1:8545',
  OPERATOR_PRIVATE_KEY_LOCAL: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  OPERATOR_PRIVATE_KEY_TESTNET: undefined,
  OPERATOR_PRIVATE_KEY_MAINNET: undefined,
  ADMIN_TOKEN: TEST_ADMIN_TOKEN,
  AURORA_API_KEY: undefined,
  ONECLICK_JWT: undefined,
  ENVIO_GRAPHQL_URL: undefined,
  ATTACK_LAB_ENABLED: true,
  LOG_LEVEL: 'silent',
};

const ZERO_INTENT_ID = '0x' + '0'.repeat(64);
const ZERO_MERCHANT_ID = '0x' + '0'.repeat(64);
const FAKE_OWNER = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const adminHeaders = { authorization: `Bearer ${TEST_ADMIN_TOKEN}` };

let mongod: MongoMemoryServer;
let app: Awaited<ReturnType<typeof buildApp>>;

// ─── helpers ──────────────────────────────────────────────────────────────────

async function inject(
  method: string,
  url: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {},
) {
  return app.inject({
    method: method as any,
    url,
    payload: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    headers: { 'content-type': 'application/json', ...opts.headers },
  });
}

// ─── lifecycle ────────────────────────────────────────────────────────────────

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await connectDb(mongod.getUri());
  app = await buildApp(testEnv);
  await app.ready();
}, 30_000);

afterAll(async () => {
  await app.close();
  await mongoose.disconnect();
  await mongod.stop();
});

// ─── tests ────────────────────────────────────────────────────────────────────

describe('GET /health', () => {
  it('returns 200 with ok:true when DB and chain are up', async () => {
    const res = await inject('GET', '/health');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.mongo).toBe('up');
    expect(Array.isArray(body.chains)).toBe(true);
    expect(body.chains[0].chainId).toBe(31337);
    expect(body.chains[0].block).toBe('100');
  });
});

describe('GET /v1/config', () => {
  it('returns config with chains array and feeBps', async () => {
    const res = await inject('GET', '/v1/config');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.icdVersion).toBe(1);
    expect(typeof body.publicAppUrl).toBe('string');
    expect(Array.isArray(body.chains)).toBe(true);
    expect(body.chains[0].chainId).toBe(31337);
    expect(body.chains[0].features).toBeDefined();
    expect(body.chains[0].deployment.config.feeBps).toBe(30);
  });
});

describe('GET /v1/fx', () => {
  it('returns 1:1 for USD (no external call)', async () => {
    const res = await inject('GET', '/v1/fx?quote=USD');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.base).toBe('USD');
    expect(body.quote).toBe('USD');
    expect(body.rate).toBe(1);
    expect(body.stale).toBe(false);
  });

  it('returns 400 for invalid currency code (too long)', async () => {
    const res = await inject('GET', '/v1/fx?quote=TOOLONG');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });
});

describe('Merchant endpoints', () => {
  it('GET /v1/merchants/by-owner/:chainId/:owner returns empty array initially', async () => {
    const res = await inject('GET', `/v1/merchants/by-owner/31337/${FAKE_OWNER}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.merchants)).toBe(true);
    expect(body.merchants.length).toBe(0);
  });

  it('GET /v1/merchants/by-owner returns 400 for invalid address', async () => {
    const res = await inject('GET', '/v1/merchants/by-owner/31337/not-an-address');
    expect(res.statusCode).toBe(400);
  });

  it('GET /v1/merchants/:chainId/:merchantId returns 404 for unknown merchantId', async () => {
    const res = await inject('GET', `/v1/merchants/31337/${ZERO_MERCHANT_ID}`);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('MERCHANT_NOT_FOUND');
  });

  it('GET /v1/merchants/:chainId/:merchantId/payments returns 200 with empty items', async () => {
    const res = await inject('GET', `/v1/merchants/31337/${ZERO_MERCHANT_ID}/payments`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBe(0);
  });

  it('GET /v1/merchants/:chainId/:merchantId/stats returns 200 with zero counts', async () => {
    const res = await inject('GET', `/v1/merchants/31337/${ZERO_MERCHANT_ID}/stats`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.paymentCount).toBe('number');
    expect(body.paymentCount).toBe(0);
  });

  it('GET /v1/merchants/:chainId/:merchantId/keys returns 200 with empty events', async () => {
    const res = await inject('GET', `/v1/merchants/31337/${ZERO_MERCHANT_ID}/keys`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.events)).toBe(true);
  });

  it('POST /v1/merchants/register returns 400 for empty body', async () => {
    const res = await inject('POST', '/v1/merchants/register', { body: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /v1/stats/:chainId', () => {
  it('returns protocol stats for chainId 31337', async () => {
    const res = await inject('GET', '/v1/stats/31337');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.merchants).toBe('number');
    expect(typeof body.activeMerchants).toBe('number');
    expect(typeof body.intents).toBe('number');
    expect(typeof body.volume).toBe('string');
  });
});

describe('Invoice endpoints', () => {
  it('GET /v1/invoices/:shortCode returns 404 for unknown shortCode', async () => {
    const res = await inject('GET', '/v1/invoices/notfound');
    expect(res.statusCode).toBe(404);
  });

  it('GET /v1/invoices/:shortCode returns 400 for too-short code', async () => {
    const res = await inject('GET', '/v1/invoices/ab');
    expect(res.statusCode).toBe(400);
  });

  it('POST /v1/invoices returns 400 for empty body', async () => {
    const res = await inject('POST', '/v1/invoices', { body: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('POST /v1/invoice-requests returns 400 for empty body', async () => {
    const res = await inject('POST', '/v1/invoice-requests', { body: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });
});

describe('Payment flow endpoints', () => {
  it('GET /v1/routes returns 400 when shortCode is missing', async () => {
    const res = await inject('GET', '/v1/routes');
    expect(res.statusCode).toBe(400);
  });

  it('GET /v1/routes returns 404 for unknown shortCode', async () => {
    const res = await inject('GET', '/v1/routes?shortCode=abcdef12');
    expect(res.statusCode).toBe(404);
  });

  it('POST /v1/quotes returns 400 VALIDATION_ERROR for empty body', async () => {
    const res = await inject('POST', '/v1/quotes', { body: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('POST /v1/quotes returns 400 for invalid route', async () => {
    const res = await inject('POST', '/v1/quotes', {
      body: { shortCode: 'abcdef12', route: 'INVALID', payer: FAKE_OWNER },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /v1/intents/prepare returns 400 for missing fields', async () => {
    const res = await inject('POST', '/v1/intents/prepare', { body: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('POST /v1/intents/submit returns 400 for empty body', async () => {
    const res = await inject('POST', '/v1/intents/submit', { body: {} });
    expect(res.statusCode).toBe(400);
  });

  it('POST /v1/intents/submit returns 404 for non-existent draftId', async () => {
    const res = await inject('POST', '/v1/intents/submit', {
      body: { draftId: ZERO_INTENT_ID, payerSig: '0x' + 'aa'.repeat(65) },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('INTENT_NOT_FOUND');
  });

  it('GET /v1/intents/:chainId/:intentId returns 404 for unknown intentId', async () => {
    const res = await inject('GET', `/v1/intents/31337/${ZERO_INTENT_ID}`);
    expect(res.statusCode).toBe(404);
  });

  it('GET /v1/intents/:chainId/:intentId returns 400 for malformed intentId', async () => {
    const res = await inject('GET', '/v1/intents/31337/notahex');
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /v1/allowance', () => {
  it('returns 400 for missing params', async () => {
    const res = await inject('GET', '/v1/allowance');
    expect(res.statusCode).toBe(400);
  });

  it('returns allowance value for valid params', async () => {
    const usdc = dep.tokens.USDC!.address;
    // param is "address" (the owner whose allowance we check), "token" is the ERC-20 address
    const res = await inject(
      'GET',
      `/v1/allowance?chainId=31337&address=${FAKE_OWNER}&token=${usdc}`,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.allowance).toBe('string');
    expect(body.allowance).toBe('1000000000');
    expect(typeof body.balance).toBe('string');
  });
});

describe('GET /v1/verify/:chainId/:intentId', () => {
  it('returns NOT_FOUND verdict for unknown intentId', async () => {
    const res = await inject('GET', `/v1/verify/31337/${ZERO_INTENT_ID}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.verdict).toBe('NOT_FOUND');
    expect(body.chainId).toBe(31337);
    expect(body.intentId).toBe(ZERO_INTENT_ID);
    expect(body.proofs.merchant.checks).toHaveLength(0);
    expect(body.links).toBeDefined();
    expect(Array.isArray(body.trustNotes)).toBe(true);
  });
});

describe('Attack lab', () => {
  it('GET /v1/attack/scenarios returns 8 scenarios', async () => {
    const res = await inject('GET', '/v1/attack/scenarios');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.scenarios)).toBe(true);
    expect(body.scenarios.length).toBe(8);
    const ids: string[] = body.scenarios.map((s: any) => s.id);
    for (const id of ['tamper_amount', 'tamper_destination', 'replay', 'expired',
      'unregistered_qr', 'fake_provider_success', 'forged_settlement_hash', 'wrong_token']) {
      expect(ids).toContain(id);
    }
  });

  it('POST /v1/attack/run returns 400 for missing body', async () => {
    const res = await inject('POST', '/v1/attack/run', { body: {} });
    expect(res.statusCode).toBe(400);
  });
});

describe('Admin routes', () => {
  it('returns 401 without auth token', async () => {
    const res = await inject('GET', '/v1/admin/merchants?chainId=31337');
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });

  it('returns 401 with wrong token', async () => {
    const res = await inject('GET', '/v1/admin/merchants?chainId=31337', {
      headers: { authorization: 'Bearer wrong-token-here' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 200 empty list with correct admin token', async () => {
    const res = await inject('GET', '/v1/admin/merchants?chainId=31337', { headers: adminHeaders });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.merchants)).toBe(true);
    expect(body.merchants.length).toBe(0);
  });
});

describe('Not Found handler', () => {
  it('returns 404 for unknown routes', async () => {
    const res = await inject('GET', '/v1/does-not-exist');
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('returns non-2xx for wrong method on known path', async () => {
    const res = await inject('DELETE', '/health');
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});
