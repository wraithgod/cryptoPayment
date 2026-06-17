import { Network, Token } from '@prisma/client';

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optionalEnv(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

// Read master private keys once, then scrub from process.env so they don't
// appear in /proc/PID/environ, docker inspect, or error stack traces
function readAndScrubKey(key: string): string {
  const val = process.env[key] ?? '';
  delete process.env[key];
  return val;
}

export const config = {
  env: optionalEnv('NODE_ENV', 'development'),
  port: parseInt(optionalEnv('PORT', '3000')),
  apiBaseUrl: optionalEnv('API_BASE_URL', 'http://localhost:3000'),

  db: {
    url: requireEnv('DATABASE_URL'),
  },

  redis: {
    url: optionalEnv('REDIS_URL', 'redis://localhost:6379'),
  },

  wallet: {
    mnemonic: requireEnv('MASTER_MNEMONIC'),
    encryptionKey: requireEnv('WALLET_ENCRYPTION_KEY'),
  },

  admin: {
    secret: requireEnv('ADMIN_SECRET'),
    ipWhitelist: (process.env.ADMIN_WHITELIST_IPS ?? '')
      .split(',')
      .map((ip) => ip.trim())
      .filter(Boolean),
    bullboardPassword: optionalEnv('BULLBOARD_PASSWORD', ''),
  },

  // Master hot-wallet private keys — read once at startup, scrubbed from env
  masterPrivateKeys: {
    [Network.ETH]: readAndScrubKey('ETH_MASTER_PRIVATE_KEY'),
    [Network.BSC]: readAndScrubKey('BSC_MASTER_PRIVATE_KEY'),
    [Network.TRON]: readAndScrubKey('TRON_MASTER_PRIVATE_KEY'),
    [Network.SOLANA]: readAndScrubKey('SOLANA_MASTER_PRIVATE_KEY'),
  } as Record<Network, string>,

  corsOrigins: optionalEnv('CORS_ORIGINS', ''),

  rpc: {
    eth: requireEnv('ETH_RPC_URL'),
    ethWs: optionalEnv('ETH_WS_URL', ''),
    bsc: optionalEnv('BSC_RPC_URL', 'https://bsc-dataseed1.binance.org'),
    bscWs: optionalEnv('BSC_WS_URL', ''),
    tronFullNode: optionalEnv('TRON_FULL_NODE', 'https://api.trongrid.io'),
    tronSolidityNode: optionalEnv('TRON_SOLIDITY_NODE', 'https://api.trongrid.io'),
    tronEventServer: optionalEnv('TRON_EVENT_SERVER', 'https://api.trongrid.io'),
    tronApiKey: optionalEnv('TRON_API_KEY', ''),
    solana: optionalEnv('SOLANA_RPC_URL', 'https://api.mainnet-beta.solana.com'),
  },

  masterWallets: {
    [Network.ETH]: optionalEnv('ETH_MASTER_ADDRESS', ''),
    [Network.BSC]: optionalEnv('BSC_MASTER_ADDRESS', ''),
    [Network.TRON]: optionalEnv('TRON_MASTER_ADDRESS', ''),
    [Network.SOLANA]: optionalEnv('SOLANA_MASTER_ADDRESS', ''),
  } as Record<Network, string>,

  fees: {
    defaultPercent: parseFloat(optionalEnv('DEFAULT_FEE_PERCENT', '1.0')),
  },

  confirmations: {
    [Network.ETH]: parseInt(optionalEnv('ETH_CONFIRMATIONS', '12')),
    [Network.BSC]: parseInt(optionalEnv('BSC_CONFIRMATIONS', '15')),
    [Network.TRON]: parseInt(optionalEnv('TRON_CONFIRMATIONS', '19')),
    // Solana: use finalized commitment (~32 slots ≈ 12s) for payment safety
    [Network.SOLANA]: parseInt(optionalEnv('SOLANA_CONFIRMATIONS', '32')),
  } as Record<Network, number>,

  webhook: {
    maxRetries: parseInt(optionalEnv('WEBHOOK_MAX_RETRIES', '5')),
    retryDelayMs: parseInt(optionalEnv('WEBHOOK_RETRY_DELAY_MS', '5000')),
  },
};

// Token contract addresses per network
export const TOKEN_CONTRACTS: Partial<Record<Network, Partial<Record<Token, string>>>> = {
  [Network.ETH]: {
    [Token.USDT]: '0x7169D38820dfd117C3FA1f22a697dBA58d90BA06', // Sepolia testnet
    [Token.USDC]: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  },
  [Network.BSC]: {
    [Token.USDT]: '0x55d398326f99059fF775485246999027B3197955',
    [Token.USDC]: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
  },
  [Network.TRON]: {
    [Token.USDT]: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    [Token.USDC]: 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8',
  },
  [Network.SOLANA]: {
    [Token.USDT]: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    [Token.USDC]: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  },
};

// Native tokens per network
export const NATIVE_TOKENS: Record<Network, Token> = {
  [Network.ETH]: Token.ETH,
  [Network.BSC]: Token.BNB,
  [Network.TRON]: Token.TRX,
  [Network.SOLANA]: Token.SOL,
};

// Supported tokens per network
export const SUPPORTED_TOKENS: Record<Network, Token[]> = {
  [Network.ETH]: [Token.ETH, Token.USDT, Token.USDC],
  [Network.BSC]: [Token.BNB, Token.USDT, Token.USDC],
  [Network.TRON]: [Token.TRX, Token.USDT, Token.USDC],
  [Network.SOLANA]: [Token.SOL, Token.USDT, Token.USDC],
};
