import { Network } from '@prisma/client';
import { BlockchainAdapter } from '../../types';
import { ethAdapter, bscAdapter } from './evm';
import { tronAdapter } from './tron';
import { solanaAdapter } from './solana';

const adapters: Record<Network, BlockchainAdapter> = {
  [Network.ETH]: ethAdapter,
  [Network.BSC]: bscAdapter,
  [Network.TRON]: tronAdapter,
  [Network.SOLANA]: solanaAdapter,
};

export function getAdapter(network: Network): BlockchainAdapter {
  const adapter = adapters[network];
  if (!adapter) throw new Error(`No adapter for network: ${network}`);
  return adapter;
}

export { ethAdapter, bscAdapter, tronAdapter, solanaAdapter };
