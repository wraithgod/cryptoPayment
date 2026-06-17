import { Job } from 'bullmq';
import { createWorker, QUEUES } from './queue';
import { sweepService } from '../services/sweepService';
import { webhookService } from '../services/webhookService';
import { prisma } from '../db';
import pino from 'pino';

const logger = pino({ name: 'sweep-worker' });

export const sweepWorker = createWorker(
  QUEUES.SWEEP,
  async (job: Job<{ paymentId: string }>) => {
    const { paymentId } = job.data;
    logger.info({ paymentId }, 'Processing sweep');

    try {
      await sweepService.sweepPayment(paymentId);

      const payment = await prisma.payment.findUnique({
        where: { id: paymentId },
      });
      if (!payment) return;

      await webhookService.queueWebhook(
        'PAYMENT_COMPLETED',
        {
          event: 'payment.completed',
          paymentId,
          userId: payment.userId ?? undefined,
          network: payment.network,
          token: payment.token,
          amount: payment.receivedAmount.toString(),
          status: 'COMPLETED',
          txHash: payment.sweepTxHash ?? undefined,
          timestamp: new Date().toISOString(),
        },
        paymentId,
      );

      logger.info({ paymentId }, 'Sweep completed');
    } catch (err) {
      logger.error({ paymentId, err }, 'Sweep failed');
      throw err;
    }
  },
  2, // max 2 concurrent sweeps
);

sweepWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, paymentId: job?.data?.paymentId, err }, 'Sweep job failed permanently');
});
