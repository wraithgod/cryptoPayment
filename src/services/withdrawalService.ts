import { Network, Token, WithdrawalStatus } from '@prisma/client';
import { parseUnits } from 'ethers';
import { prisma } from '../db';
import { getAdapter } from '../blockchain/adapters';
import { getSettings } from './settingsService';
import { config, SUPPORTED_TOKENS } from '../config';
import { CreateWithdrawalRequest, WithdrawalResponse } from '../types';

// Token decimals for on-chain amount conversion
const TOKEN_DECIMALS: Record<Token, number> = {
  [Token.ETH]: 18,
  [Token.BNB]: 18,
  [Token.TRX]: 6,
  [Token.SOL]: 9,
  [Token.USDT]: 6,
  [Token.USDC]: 6,
};

export class WithdrawalService {
  async createWithdrawal(req: CreateWithdrawalRequest): Promise<WithdrawalResponse> {
    if (!SUPPORTED_TOKENS[req.network]?.includes(req.token)) {
      throw new Error(`Token ${req.token} not supported on ${req.network}`);
    }

    const adapter = getAdapter(req.network);
    if (!adapter.isValidAddress(req.toAddress)) {
      throw new Error(`Invalid ${req.network} address: ${req.toAddress}`);
    }

    const masterAddress = config.masterWallets[req.network];
    if (!masterAddress) throw new Error(`Master wallet not configured for ${req.network}`);

    const masterBalance = await adapter.getBalance(masterAddress, req.token);
    const requestedAmount = BigInt(req.amount);
    if (masterBalance < requestedAmount) {
      throw new Error('Insufficient funds in hot wallet');
    }

    const settings = await getSettings();
    const feeAmount = (requestedAmount * BigInt(Math.round(Number(settings.feePercent) * 100))) / 10000n;

    const withdrawal = await prisma.withdrawal.create({
      data: {
        network: req.network,
        token: req.token,
        amount: req.amount,
        feeAmount: feeAmount.toString(),
        toAddress: req.toAddress,
        clientReference: req.clientReference,
      },
    });

    return this.formatWithdrawal(withdrawal);
  }

  async getWithdrawal(withdrawalId: string): Promise<WithdrawalResponse> {
    const withdrawal = await prisma.withdrawal.findFirst({ where: { id: withdrawalId } });
    if (!withdrawal) throw new Error('Withdrawal not found');
    return this.formatWithdrawal(withdrawal);
  }

  async listWithdrawals(page = 1, limit = 20) {
    const [withdrawals, total] = await Promise.all([
      prisma.withdrawal.findMany({
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.withdrawal.count(),
    ]);

    return {
      data: withdrawals.map(this.formatWithdrawal),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  async processWithdrawal(withdrawalId: string): Promise<void> {
    // Atomic claim — only one worker can win this CAS; prevents double-broadcast on retry
    const claimed = await prisma.withdrawal.updateMany({
      where: { id: withdrawalId, status: WithdrawalStatus.PENDING },
      data: { status: WithdrawalStatus.PROCESSING },
    });

    if (claimed.count === 0) return; // already claimed or completed

    try {
      const withdrawal = await prisma.withdrawal.findUnique({ where: { id: withdrawalId } });
      if (!withdrawal) throw new Error(`Withdrawal ${withdrawalId} not found after claim`);

      const adapter = getAdapter(withdrawal.network);

      const masterKey = config.masterPrivateKeys[withdrawal.network];
      if (!masterKey) throw new Error(`Master private key not configured for ${withdrawal.network}`);

      const decimals = TOKEN_DECIMALS[withdrawal.token];

      // Convert Prisma Decimal → smallest unit (wei/lamports/sun) as BigInt
      const grossAmount = parseUnits(withdrawal.amount.toString(), decimals);
      const feeAmount  = parseUnits(withdrawal.feeAmount.toString(), decimals);
      const netAmount  = grossAmount - feeAmount;

      if (netAmount <= 0n) throw new Error('Net withdrawal amount is zero or negative after fee');

      const txHash = await adapter.sendTransaction({
        fromPrivateKey: masterKey,
        toAddress: withdrawal.toAddress,
        amount: netAmount,
        token: withdrawal.token,
      });

      await prisma.withdrawal.update({
        where: { id: withdrawalId },
        data: { status: WithdrawalStatus.COMPLETED, txHash },
      });
    } catch (err) {
      // Sanitize error message — never let private keys leak into DB or logs via err.message
      const safeReason = err instanceof Error
        ? err.message.replace(/0x[0-9a-fA-F]{32,}/g, '[REDACTED]')
        : 'Unknown error';

      await prisma.withdrawal.update({
        where: { id: withdrawalId },
        data: {
          status: WithdrawalStatus.FAILED,
          failReason: safeReason,
        },
      });
      throw err;
    }
  }

  async getPendingWithdrawals() {
    return prisma.withdrawal.findMany({
      where: { status: WithdrawalStatus.PENDING },
    });
  }

  private formatWithdrawal(w: {
    id: string; network: Network; token: Token; amount: { toString(): string };
    toAddress: string; status: WithdrawalStatus; txHash?: string | null;
    clientReference?: string | null; createdAt: Date; feeAmount: { toString(): string };
  }): WithdrawalResponse {
    return {
      id: w.id,
      network: w.network,
      token: w.token,
      amount: w.amount.toString(),
      toAddress: w.toAddress,
      status: w.status,
      txHash: w.txHash ?? undefined,
      clientReference: w.clientReference ?? undefined,
      createdAt: w.createdAt.toISOString(),
    };
  }
}

export const withdrawalService = new WithdrawalService();
