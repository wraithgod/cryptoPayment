import { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { prisma } from '../../db';
import { adminAuthMiddleware } from '../middleware/auth';
import { getSettings, updateSettings } from '../../services/settingsService';
import { isSafeWebhookUrl } from '../../services/webhookService';

const MAX_WEBHOOK_REPLAYS = 10;

const updateSettingsSchema = z.object({
  webhookUrl: z.string().url().optional().nullable().refine(
    (url) => !url || isSafeWebhookUrl(url),
    { message: 'Webhook URL must be a public HTTPS URL' },
  ),
  webhookSecret: z.string().min(16).optional().nullable(),
});

export async function adminRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('preHandler', adminAuthMiddleware);

  fastify.get('/admin/stats', async (_request, reply) => {
    const [payments, withdrawals, recentPayments] = await Promise.all([
      prisma.payment.groupBy({ by: ['status'], _count: true }),
      prisma.withdrawal.groupBy({ by: ['status'], _count: true }),
      prisma.payment.findMany({
        where: { status: 'COMPLETED' },
        orderBy: { completedAt: 'desc' },
        take: 10,
        include: { userWallet: { select: { address: true, userId: true } } },
      }),
    ]);

    return reply.send({
      data: {
        payments: Object.fromEntries(payments.map((p) => [p.status, p._count])),
        withdrawals: Object.fromEntries(withdrawals.map((w) => [w.status, w._count])),
        recentCompletedPayments: recentPayments.map((p) => ({
          id: p.id,
          userId: p.userWallet?.userId,
          network: p.network,
          token: p.token,
          amount: p.receivedAmount.toString(),
          completedAt: p.completedAt,
        })),
      },
    });
  });

  // Operator settings — fee, webhook
  fastify.get('/admin/settings', async (_request, reply) => {
    const settings = await getSettings();
    return reply.send({
      data: {
        webhookUrl: settings.webhookUrl,
        webhookSecret: settings.webhookSecret ? '***' : null,
        updatedAt: settings.updatedAt,
      },
    });
  });

  fastify.patch('/admin/settings', async (request, reply) => {
    const body = updateSettingsSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'Validation error', details: body.error.flatten() });
    }

    const settings = await updateSettings(body.data);
    return reply.send({
      data: {
        webhookUrl: settings.webhookUrl,
        webhookSecret: settings.webhookSecret ? '***' : null,
        updatedAt: settings.updatedAt,
      },
    });
  });

  fastify.get('/admin/payments', async (request, reply) => {
    const query = z.object({
      page: z.coerce.number().int().positive().default(1),
      limit: z.coerce.number().int().min(1).max(100).default(20),
      network: z.string().optional(),
      status: z.string().optional(),
      userId: z.string().optional(),
    }).parse(request.query);

    const where = {
      ...(query.network && { network: query.network as never }),
      ...(query.status && { status: query.status as never }),
      ...(query.userId && { userId: query.userId }),
    };

    const [payments, total] = await Promise.all([
      prisma.payment.findMany({
        where,
        include: { userWallet: { select: { address: true, userId: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      prisma.payment.count({ where }),
    ]);

    return reply.send({
      data: payments.map((p) => ({
        ...p,
        address: p.userWallet?.address,
        userId: p.userWallet?.userId,
        receivedAmount: p.receivedAmount.toString(),
      })),
      pagination: { page: query.page, limit: query.limit, total, pages: Math.ceil(total / query.limit) },
    });
  });

  fastify.get('/admin/users', async (request, reply) => {
    const query = z.object({
      page:   z.coerce.number().int().positive().default(1),
      limit:  z.coerce.number().int().min(1).max(100).default(20),
      search: z.string().optional(),
    }).parse(request.query);

    // Get all wallets with payment status counts
    const allWallets = await prisma.userWallet.findMany({
      where: query.search ? { userId: { contains: query.search, mode: 'insensitive' } } : undefined,
      include: {
        payments: { select: { status: true, receivedAmount: true, token: true, network: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    // Group wallets by userId
    const userMap = new Map<string, { createdAt: Date; wallets: typeof allWallets }>();
    for (const w of allWallets) {
      if (!userMap.has(w.userId)) userMap.set(w.userId, { createdAt: w.createdAt, wallets: [] });
      userMap.get(w.userId)!.wallets.push(w);
    }

    const allUsers = Array.from(userMap.entries()).map(([userId, u]) => ({
      userId,
      createdAt: u.createdAt,
      wallets: u.wallets.map((w) => ({
        id: w.id,
        network: w.network,
        address: w.address,
        createdAt: w.createdAt,
        paymentCount: w.payments.length,
        completedCount: w.payments.filter((p) => p.status === 'COMPLETED').length,
      })),
      totalPayments: u.wallets.reduce((s, w) => s + w.payments.length, 0),
      completedPayments: u.wallets.reduce(
        (s, w) => s + w.payments.filter((p) => p.status === 'COMPLETED').length, 0,
      ),
    }));

    const total = allUsers.length;
    const data = allUsers.slice((query.page - 1) * query.limit, query.page * query.limit);

    return reply.send({
      data,
      pagination: { page: query.page, limit: query.limit, total, pages: Math.ceil(total / query.limit) },
    });
  });

  // Replay a failed webhook — rate-limited to MAX_WEBHOOK_REPLAYS per event
  fastify.post<{ Params: { id: string } }>('/admin/webhooks/:id/replay', async (request, reply) => {
    const event = await prisma.webhookEvent.findUnique({ where: { id: request.params.id } });
    if (!event) return reply.code(404).send({ error: 'Webhook event not found' });

    if (event.replayCount >= MAX_WEBHOOK_REPLAYS) {
      return reply.code(429).send({ error: `Max replays (${MAX_WEBHOOK_REPLAYS}) reached for this event` });
    }

    const updated = await prisma.webhookEvent.update({
      where: { id: request.params.id },
      data: {
        deliveredAt: null,
        nextRetryAt: new Date(),
        attempts: 0,
        lastError: null,
        replayCount: { increment: 1 },
      },
    });

    return reply.send({ data: updated, message: 'Queued for replay' });
  });

  fastify.get('/admin/webhooks', async (request, reply) => {
    const query = z.object({
      page: z.coerce.number().int().positive().default(1),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      failed: z.coerce.boolean().optional(),
    }).parse(request.query);

    const where = query.failed ? { deliveredAt: null, nextRetryAt: null } : {};

    const [events, total] = await Promise.all([
      prisma.webhookEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      prisma.webhookEvent.count({ where }),
    ]);

    return reply.send({ data: events, pagination: { page: query.page, limit: query.limit, total } });
  });
}
