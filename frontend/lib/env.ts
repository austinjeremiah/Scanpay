// NEXT_PUBLIC_* must be referenced literally so Next inlines them.
export const ENV = {
  API_URL: (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8787').replace(/\/$/, ''),
  RP_ID: process.env.NEXT_PUBLIC_RP_ID ?? 'localhost',
  RP_NAME: process.env.NEXT_PUBLIC_RP_NAME ?? 'ScanPay',
  DEFAULT_CHAIN_ID: Number(process.env.NEXT_PUBLIC_DEFAULT_CHAIN_ID ?? 10143),
  RPC: {
    31337: 'http://127.0.0.1:8545',
    10143: process.env.NEXT_PUBLIC_RPC_10143 ?? 'https://testnet-rpc.monad.xyz',
    143: process.env.NEXT_PUBLIC_RPC_143 ?? 'https://rpc.monad.xyz',
  } as Record<number, string>,
};
