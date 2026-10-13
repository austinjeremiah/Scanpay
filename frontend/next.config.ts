import path from 'node:path';
import type { NextConfig } from 'next';

const root = path.join(__dirname, '..');

const nextConfig: NextConfig = {
  // the dev-mode badge would sit on top of the page's own fixed elements
  devIndicators: false,
  // @scanpay/shared is TypeScript source that lives outside this project (no build step)
  outputFileTracingRoot: root,
  transpilePackages: ['@scanpay/shared'],
  turbopack: {
    root,
    resolveAlias: {
      '@scanpay/shared': '../backend/packages/shared/src/index.ts',
      // files outside this project must resolve dependencies from the frontend's node_modules
      viem: './node_modules/viem',
      zod: './node_modules/zod',
    },
  },
  // Mirror the turbopack resolveAlias for webpack (next build / Railway).
  webpack(config) {
    config.resolve.alias = {
      ...config.resolve.alias,
      '@scanpay/shared': path.join(root, 'backend/packages/shared/src/index.ts'),
      viem: path.join(__dirname, 'node_modules/viem'),
      zod: path.join(__dirname, 'node_modules/zod'),
    };
    return config;
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'Permissions-Policy', value: 'camera=(self), publickey-credentials-get=(self), publickey-credentials-create=(self)' },
        ],
      },
    ];
  },
};

export default nextConfig;
