import TronWeb from 'tronweb';
import { Network, Token } from '@prisma/client';
import { BaseAdapter } from './base';
import { TransactionInfo, SendTransactionParams } from '../../types';
import { config, TOKEN_CONTRACTS } from '../../config';

const TRC20_ABI = [
  {
    constant: true,
    inputs: [{ name: 'who', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    type: 'Function',
  },
  {
    constant: false,
    inputs: [
      { name: '_to', type: 'address' },
      { name: '_value', type: 'uint256' },
    ],
    name: 'transfer',
    outputs: [{ name: '', type: 'bool' }],
    type: 'Function',
  },
];

export class TronAdapter extends BaseAdapter {
  network = Network.TRON;
  private tronWeb: TronWeb;

  constructor() {
    super();
    this.tronWeb = new TronWeb({
      fullHost: config.rpc.tronFullNode,
      headers: config.rpc.tronApiKey ? { 'TRON-PRO-API-KEY': config.rpc.tronApiKey } : {},
    });
  }

  async getBalance(address: string, token: Token): Promise<bigint> {
    if (token === Token.TRX) {
      const balance = await this.tronWeb.trx.getBalance(address);
      return BigInt(balance);
    }
    const contractAddress = TOKEN_CONTRACTS[Network.TRON]?.[token];
    if (!contractAddress) throw new Error(`No contract for ${token} on TRON`);

    this.tronWeb.setAddress(address);
    const contract = await this.tronWeb.contract(TRC20_ABI, contractAddress);
    const balance = await contract.balanceOf(address).call();
    return BigInt(balance.toString());
  }

  async getTransaction(txHash: string): Promise<TransactionInfo | null> {
    try {
      const tx = await this.tronWeb.trx.getTransaction(txHash);
      const txInfo = await this.tronWeb.trx.getTransactionInfo(txHash);
      if (!tx) return null;

      const latestBlock = await this.getLatestBlock();
      const txBlock = txInfo?.blockNumber ?? 0;
      const confirmations = txBlock ? latestBlock - txBlock : 0;

      const txAny = tx as Record<string, unknown>;
      const contract = ((txAny['raw_data'] as Record<string, unknown>)?.['contract'] as unknown[])?.[0] as Record<string, unknown> | undefined;
      const value = (contract?.['parameter'] as Record<string, unknown>)?.['value'] as Record<string, unknown> | undefined;
      const from = this.tronWeb.address.fromHex((value?.['owner_address'] as string) ?? '');
      const to = this.tronWeb.address.fromHex((value?.['to_address'] as string) ?? '');
      const amount = (value?.['amount'] as number) ?? 0;

      return {
        hash: txHash,
        from,
        to,
        value: BigInt(amount),
        blockNumber: txBlock,
        confirmations,
        status: txInfo?.receipt?.result === 'SUCCESS' ? 'success' : txInfo ? 'failed' : 'pending',
      };
    } catch {
      return null;
    }
  }

  async getLatestBlock(): Promise<number> {
    const block = await this.tronWeb.trx.getCurrentBlock();
    return block.block_header?.raw_data?.number ?? 0;
  }

  async sendTransaction(params: SendTransactionParams): Promise<string> {
    this.tronWeb.setPrivateKey(params.fromPrivateKey);

    if (params.token === Token.TRX) {
      const tx = await this.tronWeb.trx.sendTransaction(params.toAddress, params.amount.toString());
      return tx.txid;
    }

    const contractAddress = TOKEN_CONTRACTS[Network.TRON]?.[params.token];
    if (!contractAddress) throw new Error(`No contract for ${params.token} on TRON`);

    const contract = await this.tronWeb.contract(TRC20_ABI, contractAddress);
    const result = await contract.transfer(params.toAddress, params.amount.toString()).send({
      feeLimit: 100_000_000,
      callValue: 0,
    });
    return result;
  }

  isValidAddress(address: string): boolean {
    return this.tronWeb.isAddress(address);
  }

  // Scan TRC20 transfers to a given address
  async scanTrc20Transfers(
    contractAddress: string,
    toAddress: string,
    minTimestamp: number,
  ): Promise<Array<{ txHash: string; from: string; amount: bigint; blockNumber: number }>> {
    try {
      const url = `${config.rpc.tronFullNode}/v1/accounts/${toAddress}/transactions/trc20?contract_address=${contractAddress}&only_to=true&min_timestamp=${minTimestamp}&limit=50`;
      const response = await fetch(url, {
        headers: config.rpc.tronApiKey ? { 'TRON-PRO-API-KEY': config.rpc.tronApiKey } : {},
      });
      const data = await response.json() as { data?: Array<{ transaction_id: string; from: string; value: string }> };
      return (data.data ?? []).map((tx) => ({
        txHash: tx.transaction_id,
        from: tx.from,
        amount: BigInt(tx.value),
        blockNumber: 0,
      }));
    } catch {
      return [];
    }
  }

  // Scan native TRX transfers to a given address
  async scanNativeTrxTransfers(
    toAddress: string,
    minTimestamp: number,
  ): Promise<Array<{ txHash: string; from: string; amount: bigint; blockNumber: number }>> {
    try {
      const url = `${config.rpc.tronFullNode}/v1/accounts/${toAddress}/transactions?only_to=true&min_timestamp=${minTimestamp}&limit=50`;
      const response = await fetch(url, {
        headers: config.rpc.tronApiKey ? { 'TRON-PRO-API-KEY': config.rpc.tronApiKey } : {},
      });
      const data = await response.json() as {
        data?: Array<{
          txID: string;
          raw_data?: { contract?: Array<{ parameter?: { value?: { owner_address?: string; amount?: number }; type_url?: string } }> };
        }>;
      };

      const results = [];
      for (const tx of data.data ?? []) {
        const contract = tx.raw_data?.contract?.[0];
        // Only TransferContract (native TRX transfer)
        if (!contract?.parameter?.type_url?.includes('TransferContract')) continue;
        const val = contract.parameter?.value;
        if (!val?.amount || !val?.owner_address) continue;
        results.push({
          txHash: tx.txID,
          from: this.tronWeb.address.fromHex(val.owner_address),
          amount: BigInt(val.amount),
          blockNumber: 0,
        });
      }
      return results;
    } catch {
      return [];
    }
  }
}

export const tronAdapter = new TronAdapter();
