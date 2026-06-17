import { Job } from 'bullmq';
import { createWorker, QUEUES } from './queue';
import { withdrawalService } from '../services/withdrawalService';
import { webhookService } from '../services/webhookService';
import { prisma } from '../db';
import pino from 'pino';

const logger = pino({ name: 'withdrawal-worker' });

export const withdrawalWorker = createWorker(
  QUEUES.WITHDRAWAL,
  async (job: Job<{ withdrawalId: string }>) => {
    const { withdrawalId } = job.data;
    logger.info({ withdrawalId }, 'Processing withdrawal');

    try {
      await withdrawalService.processWithdrawal(withdrawalId);

      const withdrawal = await prisma.withdrawal.findUnique({ where: { id: withdrawalId } });
      if (!withdrawal) return;

      await webhookService.queueWebhook(
        'WITHDRAWAL_COMPLETED',
        {
          event: 'withdrawal.completed',
          withdrawalId,
          network: withdrawal.network,
          token: withdrawal.token,
          amount: withdrawal.amount.toString(),
          status: 'COMPLETED',
          txHash: withdrawal.txHash ?? undefined,
          clientReference: withdrawal.clientReference ?? undefined,
          timestamp: new Date().toISOString(),
        },
        undefined,
        withdrawalId,
      );

      logger.info({ withdrawalId }, 'Withdrawal completed');
    } catch (err) {
      logger.error({ withdrawalId, err }, 'Withdrawal failed');

      const withdrawal = await prisma.withdrawal.findUnique({ where: { id: withdrawalId } });
      if (withdrawal) {
        await webhookService.queueWebhook(
          'WITHDRAWAL_FAILED',
          {
            event: 'withdrawal.failed',
            withdrawalId,
            network: withdrawal.network,
            token: withdrawal.token,
            amount: withdrawal.amount.toString(),
            status: 'FAILED',
            timestamp: new Date().toISOString(),
          },
          undefined,
          withdrawalId,
        );
      }

      throw err;
    }
  },
  3,
);

withdrawalWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, withdrawalId: job?.data?.withdrawalId, err }, 'Withdrawal job failed');
});
