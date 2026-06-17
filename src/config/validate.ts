import pino from 'pino';

const logger = pino({ level: 'info' });

const REQUIRED = [
  'DATABASE_URL',
  'REDIS_URL',
  'MASTER_MNEMONIC',
  'WALLET_ENCRYPTION_KEY',
  'ADMIN_SECRET',
] as const;

const WARN_IF_MISSING = [
  'ETH_RPC_URL',
  'BSC_RPC_URL',
  'TRON_FULL_NODE',
  'SOLANA_RPC_URL',
  'ETH_MASTER_ADDRESS',
  'TELEGRAM_BOT_TOKEN',
] as const;

export function validateEnv(): void {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables:\n${missing.map((k) => `  - ${k}`).join('\n')}\n\nCopy .env.example to .env and fill in the values.`,
    );
  }

  const mnemonic = process.env.MASTER_MNEMONIC ?? '';
  if (mnemonic.trim().split(/\s+/).length < 12) {
    throw new Error('MASTER_MNEMONIC must be at least 12 words (24 recommended)');
  }

  // Enforce exactly 64 hex chars — matches KeystoreManager requirement
  const encKey = process.env.WALLET_ENCRYPTION_KEY ?? '';
  if (!/^[0-9a-fA-F]{64}$/.test(encKey)) {
    throw new Error(
      'WALLET_ENCRYPTION_KEY must be exactly 64 hex characters (32 random bytes).\n' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }

  for (const key of WARN_IF_MISSING) {
    if (!process.env[key]) {
      logger.warn({ env: key }, `${key} is not set — related features will be limited`);
    }
  }
}
