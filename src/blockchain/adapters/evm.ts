import { ethers } from 'ethers';
import { Network, Token } from '@prisma/client';
import { BaseAdapter } from './base';
import { TransactionInfo, SendTransactionParams } from '../../types';
import { config, TOKEN_CONTRACTS } from '../../config';

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];

export class EvmAdapter extends BaseAdapter {
  network: Network;
  private provider: ethers.JsonRpcProvider;
  private rpcUrl: string;

  // Cache full blocks so multiple wallet scans in the same tick share fetches
  private blockCache: Map<number, ethers.Block | null> = new Map();
  private blockCacheExpiry = 0;

  constructor(network: Network) {
    super();
    this.network = network;
    this.rpcUrl = network === Network.ETH ? config.rpc.eth : config.rpc.bsc;
    // Specify chainId + disable request batching (batch of 12+ calls can timeout on free RPCs)
    const chainId = network === Network.ETH ? 11155111 : 56; // Sepolia / BSC Mainnet
    this.provider = new ethers.JsonRpcProvider(
      this.rpcUrl,
      { chainId, name: network.toLowerCase() },
      { batchMaxCount: 1 },
    );
  }

  private async getBlockCached(bn: number): Promise<ethers.Block | null> {
    if (Date.now() > this.blockCacheExpiry) {
      this.blockCache.clear();
      this.blockCacheExpiry = Date.now() + 30_000;
    }
    if (this.blockCache.has(bn)) return this.blockCache.get(bn)!;
    const block = await this.withTimeout(this.provider.getBlock(bn, true));
    this.blockCache.set(bn, block);
    return block;
  }

  async getBalance(address: string, token: Token): Promise<bigint> {
    if (token === Token.ETH || token === Token.BNB) {
      return await this.provider.getBalance(address);
    }
    const contractAddress = TOKEN_CONTRACTS[this.network]?.[token];
    if (!contractAddress) throw new Error(`No contract for ${token} on ${this.network}`);
    const contract = new ethers.Contract(contractAddress, ERC20_ABI, this.provider);
    return BigInt(await contract.balanceOf(address));
  }

  private withTimeout<T>(promise: Promise<T>, ms = 15_000): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`RPC call timed out after ${ms}ms`)), ms),
      ),
    ]);
  }

  async getTransaction(txHash: string): Promise<TransactionInfo | null> {
    const [tx, receipt] = await this.withTimeout(Promise.all([
      this.provider.getTransaction(txHash),
      this.provider.getTransactionReceipt(txHash),
    ]));
    if (!tx) return null;

    const latestBlock = await this.withTimeout(this.provider.getBlockNumber());
    const confirmations = receipt?.blockNumber ? latestBlock - receipt.blockNumber : 0;

    return {
      hash: txHash,
      from: tx.from,
      to: tx.to ?? '',
      value: tx.value,
      blockNumber: receipt?.blockNumber ?? 0,
      confirmations,
      status: receipt ? (receipt.status === 1 ? 'success' : 'failed') : 'pending',
    };
  }

  async getLatestBlock(): Promise<number> {
    return this.withTimeout(this.provider.getBlockNumber());
  }

  async sendTransaction(params: SendTransactionParams): Promise<string> {
    const signer = new ethers.Wallet(params.fromPrivateKey, this.provider);

    if (params.token === Token.ETH || params.token === Token.BNB) {
      const tx = await signer.sendTransaction({
        to: params.toAddress,
        value: params.amount,
      });
      return tx.hash;
    }

    const contractAddress = TOKEN_CONTRACTS[this.network]?.[params.token];
    if (!contractAddress) throw new Error(`No contract for ${params.token} on ${this.network}`);
    const contract = new ethers.Contract(contractAddress, ERC20_ABI, signer);
    const tx = await contract.transfer(params.toAddress, params.amount);
    return tx.hash;
  }

  isValidAddress(address: string): boolean {
    return ethers.isAddress(address);
  }

  // ERC-20 incoming transfers via standard eth_getLogs — works on any RPC
  async scanErc20Transfers(
    contractAddress: string,
    toAddress: string,
    fromBlock: number,
    toBlock: number,
  ): Promise<Array<{ txHash: string; from: string; amount: bigint; blockNumber: number }>> {
    // Transfer(address indexed from, address indexed to, uint256 value)
    const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    const paddedTo = '0x' + toAddress.slice(2).padStart(64, '0').toLowerCase();

    const logs = await this.withTimeout(
      this.provider.getLogs({
        address: contractAddress,
        topics: [TRANSFER_TOPIC, null, paddedTo],
        fromBlock,
        toBlock,
      }),
    );

    return logs
      .filter(l => l.data && l.data !== '0x')
      .map(l => ({
        txHash: l.transactionHash,
        from: '0x' + l.topics[1].slice(26),
        amount: BigInt(l.data),
        blockNumber: l.blockNumber,
      }));
  }

  // Native ETH/BNB transfers — iterate blocks and filter by recipient address
  // Block range is typically 1-3 blocks (polled every 15 s, ~12 s/block on ETH)
  async scanNativeTransfers(
    toAddress: string,
    fromBlock: number,
    toBlock: number,
  ): Promise<Array<{ txHash: string; from: string; amount: bigint; blockNumber: number }>> {
    const results: Array<{ txHash: string; from: string; amount: bigint; blockNumber: number }> = [];
    const addr = toAddress.toLowerCase();

    // Cap range to avoid accidental full-chain scans on first startup
    const cappedFrom = Math.max(fromBlock, toBlock - 50);

    for (let bn = cappedFrom + 1; bn <= toBlock; bn++) {
      const block = await this.getBlockCached(bn);
      if (!block?.prefetchedTransactions) continue;

      for (const tx of block.prefetchedTransactions) {
        if (tx.to?.toLowerCase() === addr && tx.value > 0n) {
          results.push({
            txHash: tx.hash,
            from: tx.from,
            amount: tx.value,
            blockNumber: bn,
          });
        }
      }
    }

    return results;
  }

  getProvider(): ethers.JsonRpcProvider {
    return this.provider;
  }
}

export const ethAdapter = new EvmAdapter(Network.ETH);
export const bscAdapter = new EvmAdapter(Network.BSC);
