import { prisma } from '../db';

export async function getSettings() {
  return prisma.settings.upsert({
    where: { id: 1 },
    create: { id: 1 },
    update: {},
  });
}

export async function updateSettings(data: {
  feePercent?: number;
  webhookUrl?: string | null;
  webhookSecret?: string | null;
}) {
  return prisma.settings.upsert({
    where: { id: 1 },
    create: { id: 1, ...data },
    update: data,
  });
}
