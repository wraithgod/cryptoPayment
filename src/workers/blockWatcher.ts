import { Network, Token, PaymentStatus } from '@prisma/client';
import { prisma } from '../db';
import { getAdapter } from '../blockchain/adapters';
import { ethAdapter, bscAdapter } from '../blockchain/adapters/evm';
import { tronAdapter } from '../blockchain/adapters/tron';
import { solanaAdapter } from '../blockchain/adapters/solana';
import { paymentService } from '../services/paymentService';
import { webhookService } from '../services/webhookService';
import { alertService } from '../services/alertService';
import { getSettings } from '../services/settingsService';
import { sweepQueue } from './queue';
import { config, TOKEN_CONTRACTS, NATIVE_TOKENS, SUPPORTED_TOKENS } from '../config';
import pino from 'pino';

const logger = pino({ name: 'block-watcher' });

const BLOCK_TIMES: Record<Network, number> = {
  [Network.ETH]: 12,
  [Network.BSC]: 3,
  [Network.TRON]: 3,
  [Network.SOLANA]: 1,
};

export class BlockWatcher {
  private lastScannedBlocks: Map<Network, number> = new Map();
  private lastScanTimestamps: Map<Network, number> = new Map();
  private running = false;
  private errors: Map<Network, number> = new Map();

  async start(): Promise<void> {
    this.running = true;
    logger.info('Block watcher started');
    await Promise.all([
      this.watchNetwork(Network.ETH),
      this.watchNetwork(Network.BSC),
      this.watchNetwork(Network.TRON),
      this.watchNetwork(Network.SOLANA),
    ]);
  }

  stop(): void {
    this.running = false;
  }

  private async watchNetwork(network: Network): Promise<void> {
    const intervals: Record<Network, number> = {
      [Network.ETH]: 15000,
      [Network.BSC]: 5000,
      [Network.TRON]: 6000,
      [Network.SOLANA]: 2000,
    };

    while (this.running) {
      try {
        await this.scanNetwork(network);
        this.errors.set(network, 0);
      } catch (err) {
        const count = (this.errors.get(network) ?? 0) + 1;
        this.errors.set(network, count);
        logger.error({ network, err, consecutiveErrors: count }, 'Error scanning network');
        if (count >= 5) {
          await alertService.send(
            `Block watcher: ${network} has ${count} consecutive errors\n` +
            `Last error: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        // Exponential backoff on consecutive errors, capped at 5 minutes
        const backoffMs = Math.min(intervals[network] * Math.pow(2, Math.min(count - 1, 8)), 300_000);
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }
      await new Promise((r) => setTimeout(r, intervals[network]));
    }
  }

  private async expireStuckDetected(network: Network): Promise<void> {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const stuck = await prisma.payment.findMany({
      where: { network, status: PaymentStatus.DETECTED, createdAt: { lt: cutoff } },
    });
    if (stuck.length === 0) return;

    await prisma.payment.updateMany({
      where: { id: { in: stuck.map((p) => p.id) } },
      data: { status: PaymentStatus.FAILED },
    });
    logger.warn({ network, count: stuck.length }, 'Marked stuck DETECTED payments as FAILED');

    for (const payment of stuck) {
      await webhookService.queueWebhook('PAYMENT_FAILED', {
        event: 'payment.failed',
        paymentId: payment.id,
        userId: payment.userId ?? undefined,
        network,
        token: payment.token,
        amount: payment.receivedAmount.toString(),
        status: 'FAILED',
        txHash: payment.txHash ?? undefined,
        timestamp: new Date().toISOString(),
      }, payment.id);
    }
  }

  private async scanNetwork(network: Network): Promise<void> {
    await this.expireStuckDetected(network);

    const [pendingConfirmations, userWallets] = await Promise.all([
      prisma.payment.findMany({
        where: { network, status: PaymentStatus.DETECTED },
      }),
      prisma.userWallet.findMany({
        where: { network },
      }),
    ]);

    if (pendingConfirmations.length === 0 && userWallets.length === 0) return;

    const adapter = getAdapter(network);
    const currentBlock = await adapter.getLatestBlock();

    let lastScanned: number;
    let lastTimestamp: number;

    if (this.lastScannedBlocks.has(network)) {
      lastScanned = this.lastScannedBlocks.get(network)!;
      lastTimestamp = this.lastScanTimestamps.get(network)!;
    } else {
      const allDates = [
        ...pendingConfirmations.map((p: { createdAt: Date }) => p.createdAt),
        ...userWallets.map((w: { createdAt: Date }) => w.createdAt),
      ];
      const oldestAge = allDates.length > 0
        ? Math.max(...allDates.map((d) => Date.now() - new Date(d).getTime()))
        : 0;
      const blocksBack = Math.min(Math.ceil(oldestAge / 1000 / BLOCK_TIMES[network]) + 20, 1000);
      lastScanned = Math.max(0, currentBlock - blocksBack);
      lastTimestamp = Date.now() - oldestAge - 60_000;
    }

    logger.info(
      { network, awaitingConfirmation: pendingConfirmations.length, userWallets: userWallets.length, fromBlock: lastScanned, toBlock: currentBlock },
      'Scanning',
    );

    const settings = await getSettings();

    for (const payment of pendingConfirmations) {
      try {
        await this.checkConfirmations(network, payment as typeof payment & { userId: string; txHash: string });
      } catch (err) {
        logger.error({ paymentId: payment.id, err }, 'Error checking confirmations');
      }
    }

    for (const userWallet of userWallets) {
      try {
        await this.checkUserWalletForDeposit(network, userWallet, lastScanned, currentBlock, lastTimestamp, Number(settings.feePercent));
      } catch (err) {
        logger.error({ userWalletId: userWallet.id, userId: userWallet.userId, err }, 'Error checking user wallet');
      }
    }

    this.lastScannedBlocks.set(network, currentBlock);
    this.lastScanTimestamps.set(network, Date.now());
  }

  private async checkUserWalletForDeposit(
    network: Network,
    userWallet: {
      id: string;
      userId: string;
      address: string;
    },
    fromBlock: number,
    toBlock: number,
    fromTimestamp: number,
    feePercent: number,
  ): Promise<void> {
    // Scan every token supported on this network — one address receives all of them
    for (const token of SUPPORTED_TOKENS[network]) {
      const transfers = await this.findIncomingTransfers(
        network, token, userWallet.address, fromBlock, toBlock, fromTimestamp,
      );

      for (const transfer of transfers) {
        let payment: { id: string };
        try {
          payment = await prisma.payment.create({
            data: {
              userId: userWallet.userId,
              userWalletId: userWallet.id,
              network,
              token,
              receivedAmount: transfer.amount.toString(),
              feePercent: feePercent.toString(),
              status: PaymentStatus.DETECTED,
              txHash: transfer.txHash,
            },
          });
        } catch (e: unknown) {
          const err = e as { code?: string };
          if (err.code === 'P2002') continue; // duplicate txHash — already recorded
          throw e;
        }

        logger.info(
          { paymentId: payment.id, userId: userWallet.userId, token, txHash: transfer.txHash, amount: transfer.amount.toString() },
          'Deposit detected — payment created',
        );

        await webhookService.queueWebhook('PAYMENT_DETECTED', {
          event: 'payment.detected',
          paymentId: payment.id,
          userId: userWallet.userId,
          network,
          token,
          amount: transfer.amount.toString(),
          status: 'DETECTED',
          txHash: transfer.txHash,
          timestamp: new Date().toISOString(),
        }, payment.id);
      }
    }
  }

  private async checkConfirmations(
    network: Network,
    payment: { id: string; userId: string; txHash: string; token: Token; receivedAmount: { toString(): string } },
  ): Promise<void> {
    const adapter = getAdapter(network);
    const tx = await adapter.getTransaction(payment.txHash);
    if (!tx) return;

    const required = config.confirmations[network];

    await prisma.payment.update({
      where: { id: payment.id },
      data: { confirmations: tx.confirmations },
    });

    if (tx.confirmations < required) return;

    await paymentService.onPaymentConfirmed(payment.id);

    await webhookService.queueWebhook('PAYMENT_CONFIRMED', {
      event: 'payment.confirmed',
      paymentId: payment.id,
      userId: payment.userId,
      network,
      token: payment.token,
      amount: payment.receivedAmount.toString(),
      status: 'CONFIRMED',
      txHash: payment.txHash,
      timestamp: new Date().toISOString(),
    }, payment.id);

    await sweepQueue.add(
      'sweep',
      { paymentId: payment.id },
      { attempts: 5, backoff: { type: 'exponential', delay: 10_000 } },
    );

    logger.info({ paymentId: payment.id, confirmations: tx.confirmations }, 'Payment confirmed, sweep queued');
  }

  private async findIncomingTransfers(
    network: Network,
    token: Token,
    address: string,
    fromBlock: number,
    toBlock: number,
    fromTimestamp: number,
  ): Promise<Array<{ txHash: string; amount: bigint }>> {
    const nativeToken = NATIVE_TOKENS[network];

    if (network === Network.ETH || network === Network.BSC) {
      const adapter = network === Network.ETH ? ethAdapter : bscAdapter;
      if (token === nativeToken) return adapter.scanNativeTransfers(address, fromBlock, toBlock);
      const contractAddress = TOKEN_CONTRACTS[network]?.[token];
      if (!contractAddress) return [];
      return adapter.scanErc20Transfers(contractAddress, address, fromBlock, toBlock);
    }

    if (network === Network.TRON) {
      if (token === nativeToken) return tronAdapter.scanNativeTrxTransfers(address, fromTimestamp);
      const contractAddress = TOKEN_CONTRACTS[Network.TRON]?.[token];
      if (!contractAddress) return [];
      return tronAdapter.scanTrc20Transfers(contractAddress, address, fromTimestamp);
    }

    if (network === Network.SOLANA) {
      const transfers = await solanaAdapter.scanSignatures(address, token);
      return transfers.map((t) => ({ txHash: t.txHash, amount: t.amount }));
    }

    return [];
  }
}

export const blockWatcher = new BlockWatcher();
