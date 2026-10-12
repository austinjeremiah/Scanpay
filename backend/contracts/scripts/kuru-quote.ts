// Usage: tsx scripts/kuru-quote.ts <tokenIn> <tokenOut> <amountInBaseUnits> [slippageBps=50]
// Prints swapData = abi.encode(address target, bytes callData) for our KuruFlowAdapter (userAddress = adapter).
import { encodeAbiParameters, getAddress, type Hex } from 'viem';
import { getDeployment } from '@scanpay/shared';

const [tokenIn, tokenOut, amount, slippage = '50'] = process.argv.slice(2);
if (!tokenIn || !tokenOut || !amount) throw new Error('usage: kuru-quote.ts <tokenIn> <tokenOut> <amount> [slippageBps]');
const d = getDeployment(143);
const adapter = d.contracts.SwapAdapter.address;
const api = d.external.kuruFlowApi ?? 'https://ws.kuru.io';

const tokRes = await fetch(`${api}/api/generate-token`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ user_address: adapter }),
});
if (!tokRes.ok) throw new Error(`generate-token ${tokRes.status} ${await tokRes.text()}`);
const { token } = (await tokRes.json()) as { token: string };

await new Promise((r) => setTimeout(r, 1100)); // 1 RPS per token

const qRes = await fetch(`${api}/api/quote`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({
    userAddress: adapter,
    tokenIn: getAddress(tokenIn),
    tokenOut: getAddress(tokenOut),
    amount,
    slippageTolerance: Number(slippage),
  }),
});
if (!qRes.ok) throw new Error(`quote ${qRes.status} ${await qRes.text()}`);
const q = (await qRes.json()) as {
  status: string; output: string; minOut: string; transaction: { to: string; calldata: string; value: string };
};
const target = getAddress(q.transaction.to);
if (!d.external.kuruTargets.map((x) => x.toLowerCase()).includes(target.toLowerCase())) {
  throw new Error(`quote target ${target} not allow-listed`);
}
if (q.transaction.value && BigInt(q.transaction.value) !== 0n) throw new Error('native value quotes not supported');
const callData = (q.transaction.calldata.startsWith('0x') ? q.transaction.calldata : `0x${q.transaction.calldata}`) as Hex;
const swapData = encodeAbiParameters([{ type: 'address' }, { type: 'bytes' }], [target, callData]);
console.log(JSON.stringify({ output: q.output, minOut: q.minOut, target, swapData }, null, 2));
