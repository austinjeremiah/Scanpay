import type { FastifyPluginAsync } from 'fastify';
import {
  zAllowanceRes, zDripReq, zDripRes, zFaucetReq, zFaucetRes, zPrepareReq, zPrepareRes,
  zQuoteReq, zQuoteRes, zRoutesRes, zSimulateDepositReq, zSourceTxReq, zSubmitReq, zSubmitRes, zTxRes, zChainId, zAddress,
} from '@scanpay/shared';
import type { Address, Hex } from 'viem';
import { z } from 'zod';
import { chainCtx } from '../../chains.js';
import { parse } from '../parse.js';
import { erc20Abi } from '@scanpay/shared';
import { getRoutes, previewQuote, prepare } from '../../services/intents.js';
import { submit } from '../../services/submit.js';
import { gasDrip, faucet } from '../../services/wallet.js';
import { simulateDeposit, postSourceTx, readIntent } from '../../services/submitCrossChain.js';
import { ApiError } from '../../errors.js';

export const paymentRoutes: FastifyPluginAsync = async (app) => {
  // GET /v1/routes?shortCode=<sc>
  app.get('/v1/routes', async (req) => {
    const { shortCode } = parse(z.object({ shortCode: z.string().min(4) }), (req as any).query);
    return getRoutes(shortCode);
  });

  // POST /v1/quotes
  app.post('/v1/quotes', async (req) => {
    return previewQuote(parse(zQuoteReq, (req as any).body) as any);
  });

  // POST /v1/intents/prepare
  app.post('/v1/intents/prepare', async (req) => {
    return prepare(parse(zPrepareReq, (req as any).body) as any);
  });

  // POST /v1/intents/submit
  app.post('/v1/intents/submit', async (req) => {
    return submit(parse(zSubmitReq, (req as any).body) as any);
  });

  // GET /v1/intents/:chainId/:intentId
  app.get('/v1/intents/:chainId/:intentId', async (req) => {
    const { chainId, intentId } = parse(
      z.object({ chainId: zChainId, intentId: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }),
      (req as any).params,
    );
    return readIntent(chainId, intentId as Hex);
  });

  // POST /v1/intents/:chainId/:intentId/simulate-deposit
  app.post('/v1/intents/:chainId/:intentId/simulate-deposit', async (req) => {
    const { chainId, intentId } = parse(
      z.object({ chainId: zChainId, intentId: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }),
      (req as any).params,
    );
    const body = parse(zSimulateDepositReq, (req as any).body ?? {});
    return simulateDeposit(chainId, intentId as Hex, body.amount ? BigInt(body.amount) : undefined);
  });

  // POST /v1/intents/:chainId/:intentId/source-tx
  app.post('/v1/intents/:chainId/:intentId/source-tx', async (req) => {
    const { chainId, intentId } = parse(
      z.object({ chainId: zChainId, intentId: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }),
      (req as any).params,
    );
    const { txHash } = parse(zSourceTxReq, (req as any).body);
    return postSourceTx(chainId, intentId as Hex, txHash);
  });

  // GET /v1/allowance?chainId=&address=&token=<tokenKey|address>
  app.get('/v1/allowance', async (req) => {
    const { chainId, address, token } = parse(
      z.object({ chainId: zChainId, address: zAddress, token: z.string() }),
      (req as any).query,
    );
    const ctx = chainCtx(chainId);
    const tokenEntry = ctx.token(token as any)
      ? { key: token, token: ctx.token(token as any)! }
      : ctx.tokenByAddress(token as Address);
    if (!tokenEntry) throw new ApiError('NOT_FOUND', 'Token not found');
    const [allowance, balance] = await Promise.all([
      ctx.public.readContract({ address: tokenEntry.token.address, abi: erc20Abi, functionName: 'allowance', args: [address as any, ctx.vault] }) as Promise<bigint>,
      ctx.public.readContract({ address: tokenEntry.token.address, abi: erc20Abi, functionName: 'balanceOf', args: [address as any] }) as Promise<bigint>,
    ]);
    return { tokenKey: tokenEntry.key ?? null, spender: ctx.vault.toLowerCase() as Hex, allowance: allowance.toString(), balance: balance.toString() };
  });

  // POST /v1/gas/drip
  app.post('/v1/gas/drip', async (req) => {
    const body = parse(zDripReq, (req as any).body);
    return gasDrip(chainCtx(body.chainId), body.address as any, body.tokenKey);
  });

  // POST /v1/faucet
  app.post('/v1/faucet', async (req) => {
    const body = parse(zFaucetReq, (req as any).body);
    return faucet(chainCtx(body.chainId), body.address as any);
  });
};
