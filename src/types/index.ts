import { Network, Token, WithdrawalStatus } from '@prisma/client';

export interface CreateWithdrawalRequest {
  network: Network;
  token: Token;
  amount: string;
  toAddress: string;
  clientReference?: string;
}

export interface WithdrawalResponse {
  id: string;
  network: Network;
  token: Token;
  amount: string;
  toAddress: string;
  status: WithdrawalStatus;
  txHash?: string;
  clientReference?: string;
  createdAt: string;
}

export interface WebhookPayload {
  event: string;
  paymentId?: string;
  withdrawalId?: string;
  userId?: string;
  network: Network;
  token: Token;
  amount: string;
  status: string;
  txHash?: string;
  clientReference?: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface BlockchainAdapter {
  network: Network;
  getBalance(address: string, token: Token): Promise<bigint>;
  getTransaction(txHash: string): Promise<TransactionInfo | null>;
  getLatestBlock(): Promise<number>;
  sendTransaction(params: SendTransactionParams): Promise<string>;
  isValidAddress(address: string): boolean;
}

export interface TransactionInfo {
  hash: string;
  from: string;
  to: string;
  value: bigint;
  token?: string;
  blockNumber: number;
  confirmations: number;
  status: 'pending' | 'success' | 'failed';
}

export interface SendTransactionParams {
  fromPrivateKey: string;
  toAddress: string;
  amount: bigint;
  token: Token;
  contractAddress?: string;
}


