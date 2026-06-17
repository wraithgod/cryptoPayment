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

  constructor(network: Network) {
    super();
    this.network = network;
    this.rpcUrl = network === Network.ETH ? config.rpc.eth : config.rpc.bsc;
    this.provider = new ethers.JsonRpcProvider(this.rpcUrl);
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

  // Scan address for incoming ERC20 transfers via alchemy_getAssetTransfers (no block-range limit)
  async scanErc20Transfers(
    _contractAddress: string,
    toAddress: string,
    fromBlock: number,
    toBlock: number,
  ): Promise<Array<{ txHash: string; from: string; amount: bigint; blockNumber: number }>> {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      method: 'alchemy_getAssetTransfers',
      params: [{
        fromBlock: '0x' + fromBlock.toString(16),
        toBlock: '0x' + toBlock.toString(16),
        toAddress,
        category: ['erc20'],
        excludeZeroValue: true,
        maxCount: '0x64',
      }],
      id: 1,
    });

    const res = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(10000),
    });

    const data = await res.json() as {
      result?: {
        transfers: Array<{
          hash: string;
          from: string;
          value: number;
          blockNum: string;
          rawContract?: { value?: string };
        }>;
      };
    };
    const transfers = data.result?.transfers ?? [];

    return transfers.map((t) => ({
      txHash: t.hash,
      from: t.from,
      amount: t.rawContract?.value
        ? BigInt(t.rawContract.value)
        : ethers.parseUnits(t.value.toFixed(6), 6), // USDT/USDC = 6 decimals fallback
      blockNumber: parseInt(t.blockNum, 16),
    }));
  }

  // Scan native ETH/BNB transfers using alchemy_getAssetTransfers (1 call vs hundreds)
  async scanNativeTransfers(
    toAddress: string,
    fromBlock: number,
    toBlock: number,
  ): Promise<Array<{ txHash: string; from: string; amount: bigint; blockNumber: number }>> {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      method: 'alchemy_getAssetTransfers',
      params: [{
        fromBlock: '0x' + fromBlock.toString(16),
        toBlock: '0x' + toBlock.toString(16),
        toAddress,
        category: ['external'],
        excludeZeroValue: true,
        maxCount: '0x64',
      }],
      id: 1,
    });

    const res = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(10000),
    });

    const data = await res.json() as {
      result?: {
        transfers: Array<{
          hash: string;
          from: string;
          value: number;
          blockNum: string;
          rawContract?: { value?: string };
        }>;
      };
    };
    const transfers = data.result?.transfers ?? [];

    return transfers.map((t) => ({
      txHash: t.hash,
      from: t.from,
      // rawContract.value is hex-encoded wei — prefer it over float arithmetic to avoid precision loss
      amount: t.rawContract?.value
        ? BigInt(t.rawContract.value)
        : ethers.parseEther(t.value.toFixed(18)),
      blockNumber: parseInt(t.blockNum, 16),
    }));
  }

  getProvider(): ethers.JsonRpcProvider {
    return this.provider;
  }
}

export const ethAdapter = new EvmAdapter(Network.ETH);
export const bscAdapter = new EvmAdapter(Network.BSC);
