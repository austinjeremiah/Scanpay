export const ROUTE_NAME = ['DIRECT', 'SWAP', 'CROSSCHAIN'] as const;
export const MERCHANT_STATUS_NAME = ['NONE', 'PENDING', 'ACTIVE', 'SUSPENDED', 'REVOKED'] as const;
export const MERCHANT_ACTIVE = 2;

export const lc = (s: string) => s.toLowerCase();
export const eid = (chainId: number, hex: string) => `${chainId}_${lc(hex)}`;
export const logId = (chainId: number, txHash: string, logIndex: number) => `${chainId}_${lc(txHash)}_${logIndex}`;
export const dayStart = (ts: number | bigint) => (BigInt(ts) / 86_400n) * 86_400n;
export const num = (x: bigint | number) => Number(x);

export function emptyProtocolStat(chainId: number) {
  return {
    id: String(chainId),
    chainId,
    merchants: 0,
    activeMerchants: 0,
    intents: 0,
    settled: 0,
    refunded: 0,
    volume: 0n,
    fees: 0n,
    crossChainSettled: 0,
  };
}
