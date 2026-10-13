import { z } from 'zod';

const hexKey = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 0x-prefixed 32-byte private key');
const optKey = z.preprocess((v) => (v === '' ? undefined : v), hexKey.optional());
const optStr = z.preprocess((v) => (v === '' ? undefined : v), z.string().optional());

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(8787),
  PUBLIC_APP_URL: z.string().url().default('http://localhost:3000'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  ENABLED_CHAINS: z
    .string()
    .default('31337')
    .transform((s) => s.split(',').map((x) => Number(x.trim())).filter(Boolean)),
  MONGODB_URI: z.string().min(1),
  MONAD_TESTNET_RPC: z.string().url().default('https://testnet-rpc.monad.xyz'),
  MONAD_MAINNET_RPC: z.string().url().default('https://rpc.monad.xyz'),
  LOCAL_RPC: z.string().url().default('http://127.0.0.1:8545'),
  OPERATOR_PRIVATE_KEY_LOCAL: optKey,
  OPERATOR_PRIVATE_KEY_TESTNET: optKey,
  OPERATOR_PRIVATE_KEY_MAINNET: optKey,
  ADMIN_TOKEN: z.string().min(16),
  AURORA_API_KEY: optStr,
  ONECLICK_JWT: optStr,
  ENVIO_GRAPHQL_URL: optStr,
  ENVIO_ADMIN_SECRET: optStr,
  ATTACK_LAB_ENABLED: z
    .string()
    .default('true')
    .transform((s) => s === 'true'),
  LOG_LEVEL: z.string().default('info'),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${msg}`);
  }
  const env = parsed.data;
  for (const id of env.ENABLED_CHAINS) {
    const key = operatorKeyFor(env, id);
    if (!key) throw new Error(`ENABLED_CHAINS includes ${id} but its OPERATOR_PRIVATE_KEY_* is empty`);
  }
  return env;
}

export function operatorKeyFor(env: Env, chainId: number): `0x${string}` | undefined {
  if (chainId === 31337) return env.OPERATOR_PRIVATE_KEY_LOCAL as `0x${string}` | undefined;
  if (chainId === 10143) return env.OPERATOR_PRIVATE_KEY_TESTNET as `0x${string}` | undefined;
  if (chainId === 143) return env.OPERATOR_PRIVATE_KEY_MAINNET as `0x${string}` | undefined;
  return undefined;
}
