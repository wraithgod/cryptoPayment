import { Queue, Worker, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../config';

const connection = new IORedis(config.redis.url, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

export const QUEUES = {
  BLOCK_WATCHER: 'block-watcher',
  SWEEP: 'sweep',
  WEBHOOK: 'webhook',
  WITHDRAWAL: 'withdrawal',
} as const;

export function createQueue(name: string) {
  return new Queue(name, { connection });
}

export function createWorker<T = unknown>(
  name: string,
  processor: (job: import('bullmq').Job<T>) => Promise<void>,
  concurrency = 5,
) {
  return new Worker<T>(name, processor, { connection, concurrency });
}

export const sweepQueue = createQueue(QUEUES.SWEEP);
export const webhookQueue = createQueue(QUEUES.WEBHOOK);
export const withdrawalQueue = createQueue(QUEUES.WITHDRAWAL);

export { connection as redisConnection };
