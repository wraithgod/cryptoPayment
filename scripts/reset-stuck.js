'use strict';
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const result = await prisma.payment.updateMany({
    where: { status: 'SWEEPING', sweepTxHash: null },
    data:  { status: 'CONFIRMED' },
  });
  console.log('Reset', result.count, 'stuck payment(s) → CONFIRMED');
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
