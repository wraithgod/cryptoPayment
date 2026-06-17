import { createWorker, QUEUES } from './queue';
import { webhookService } from '../services/webhookService';
import pino from 'pino';

const logger = pino({ name: 'webhook-worker' });

// Poll for pending webhook events every 5 seconds
export function startWebhookPoller(): NodeJS.Timeout {
  return setInterval(async () => {
    try {
      await webhookService.deliverPending();
    } catch (err) {
      logger.error({ err }, 'Webhook delivery cycle failed');
    }
  }, 5000);
}
