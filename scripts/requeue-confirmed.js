'use strict';
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { Queue } = require('bullmq');
const IORedis = require('ioredis');

const prisma = new PrismaClient();
const redis = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});
const sweepQueue = new Queue('sweep', { connection: redis });

async function main() {
  const confirmed = await prisma.payment.findMany({
    where: { status: 'CONFIRMED' },
    select: { id: true, userId: true, network: true },
  });

  console.log(`Found ${confirmed.length} CONFIRMED payment(s)`);

  for (const p of confirmed) {
    const jobId = `sweep-${p.id}`;
    await sweepQueue.add('sweep', { paymentId: p.id }, {
      jobId,
      removeOnComplete: true,
      removeOnFail: false,
    });
    console.log(`  Queued sweep for ${p.id} (${p.userId}, ${p.network})`);
  }

  await prisma.$disconnect();
  await redis.quit();
}

main().catch(e => { console.error(e); process.exit(1); });
