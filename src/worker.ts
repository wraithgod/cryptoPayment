import 'dotenv/config';
import { validateEnv } from './config/validate';
validateEnv();

import http from 'http';
import { connectDb, disconnectDb } from './db';
import { prisma } from './db';
import { blockWatcher } from './workers/blockWatcher';
import { sweepWorker } from './workers/sweepWorker';
import { withdrawalWorker } from './workers/withdrawalWorker';
import { startWebhookPoller } from './workers/webhookWorker';
import { sweepQueue } from './workers/queue';
import { alertService } from './services/alertService';
import { getAdapter } from './blockchain/adapters';
import { paymentService } from './services/paymentService';
import pino from 'pino';

const logger = pino({ name: 'worker-main' });

// ── Worker health check server (default :3001) ────────────────────────────
const HEALTH_PORT = parseInt(process.env.WORKER_HEALTH_PORT ?? '3001');
const startedAt = new Date().toISOString();
let lastBlockScan: Record<string, string> = {};

function startHealthServer() {
  const server = http.createServer((_req, res) => {
    const status = {
      status: 'ok',
      startedAt,
      uptime: Math.floor(process.uptime()),
      lastBlockScan,
      memory: process.memoryUsage().rss,
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status));
  });
  server.listen(HEALTH_PORT, () => {
    logger.info(`Worker health check running on :${HEALTH_PORT}`);
  });
  return server;
}

// Recover payments stuck in SWEEPING: verify on-chain and complete or reset to CONFIRMED
async function recoverStuckSweeps(): Promise<void> {
  const cutoff = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes
  const stuck = await prisma.payment.findMany({
    where: { status: 'SWEEPING', updatedAt: { lt: cutoff } },
    include: { userWallet: true },
  });

  if (stuck.length === 0) return;
  logger.warn({ count: stuck.length }, 'Found stuck SWEEPING payments — recovering');

  for (const payment of stuck) {
    try {
      if (payment.sweepTxHash) {
        const adapter = getAdapter(payment.network);
        const tx = await adapter.getTransaction(payment.sweepTxHash);
        if (tx && tx.status === 'success') {
          // feeAmount (in smallest units) was persisted when SWEEPING status was set — read it back
          const feeAmount = BigInt(payment.feeAmount.toFixed(0));
          await paymentService.onSweepCompleted(payment.id, payment.sweepTxHash, feeAmount);
          logger.info({ paymentId: payment.id }, 'Recovered SWEEPING payment — marked COMPLETED');
          continue;
        }
      }
      // No txHash or tx not found — reset to CONFIRMED so sweep retries
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'CONFIRMED', sweepTxHash: null },
      });
      await sweepQueue.add('sweep', { paymentId: payment.id }, { attempts: 5, backoff: { type: 'exponential', delay: 10_000 } });
      logger.info({ paymentId: payment.id }, 'Recovered SWEEPING payment — reset to CONFIRMED and requeued');
    } catch (err) {
      logger.error({ paymentId: payment.id, err }, 'Failed to recover stuck SWEEPING payment');
    }
  }
}

async function main() {
  await connectDb();
  logger.info('Worker process started');

  // Recover any payments that were stuck in SWEEPING before this restart
  await recoverStuckSweeps().catch((err) => logger.error({ err }, 'Startup SWEEPING recovery failed'));

  const healthServer = startHealthServer();

  // Webhook delivery poller
  const webhookTimer = startWebhookPoller();

  // Periodic recovery for stuck SWEEPING payments (every 5 minutes)
  const sweepRecoveryTimer = setInterval(() => {
    recoverStuckSweeps().catch((err) => logger.error({ err }, 'Periodic SWEEPING recovery failed'));
  }, 5 * 60 * 1000);

  // Block watcher — crash alerts via Telegram
  blockWatcher.start().catch(async (err) => {
    logger.error({ err }, 'Block watcher crashed');
    await alertService.critical(`Block watcher crashed: ${err instanceof Error ? err.message : String(err)}`);
  });

  logger.info('All workers started: block-watcher, sweep, withdrawal, webhook');

  const shutdown = async () => {
    logger.info('Worker shutting down...');
    blockWatcher.stop();
    clearInterval(webhookTimer);
    clearInterval(sweepRecoveryTimer);
    await Promise.allSettled([sweepWorker.close(), withdrawalWorker.close()]);
    await disconnectDb();
    healthServer.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Unhandled rejections — alert and keep running
  process.on('unhandledRejection', async (reason) => {
    const msg = `Unhandled rejection in worker: ${reason}`;
    logger.error(msg);
    await alertService.critical(msg);
  });
}

main().catch(async (err) => {
  logger.error({ err }, 'Worker fatal error');
  await alertService.critical(`Worker process died: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
