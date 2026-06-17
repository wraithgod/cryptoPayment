import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Network, Token } from '@prisma/client';
import { adminAuthMiddleware } from '../middleware/auth';
import { withdrawalService } from '../../services/withdrawalService';
import { withdrawalQueue, QUEUES } from '../../workers/queue';

const MAX_WITHDRAWAL_AMOUNT = 1_000_000;

const createWithdrawalSchema = z.object({
  network: z.nativeEnum(Network),
  token: z.nativeEnum(Token),
  amount: z.string()
    .regex(/^\d+(\.\d+)?$/, 'Amount must be a positive decimal number')
    .refine((v) => parseFloat(v) > 0, 'Amount must be greater than 0')
    .refine((v) => parseFloat(v) <= MAX_WITHDRAWAL_AMOUNT, `Amount exceeds maximum withdrawal limit of ${MAX_WITHDRAWAL_AMOUNT}`),
  toAddress: z.string().min(10).max(100),
  clientReference: z.string().max(255).optional(),
});

export async function withdrawalsRoutes(fastify: FastifyInstance): Promise<void> {
  // Create withdrawal
  fastify.post('/withdrawals', {
    preHandler: adminAuthMiddleware,
    handler: async (request, reply) => {
      const body = createWithdrawalSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: 'Validation error', details: body.error.flatten() });
      }

      try {
        const withdrawal = await withdrawalService.createWithdrawal(body.data);

        // Queue for async processing
        await withdrawalQueue.add(
          QUEUES.WITHDRAWAL,
          { withdrawalId: withdrawal.id },
          { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
        );

        return reply.code(201).send({ data: withdrawal });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Internal error';
        return reply.code(400).send({ error: message });
      }
    },
  });

  // Get withdrawal status
  fastify.get<{ Params: { id: string } }>('/withdrawals/:id', {
    preHandler: adminAuthMiddleware,
    handler: async (request, reply) => {
      try {
        const withdrawal = await withdrawalService.getWithdrawal(request.params.id);
        return reply.send({ data: withdrawal });
      } catch {
        return reply.code(404).send({ error: 'Withdrawal not found' });
      }
    },
  });

  // List withdrawals
  fastify.get('/withdrawals', {
    preHandler: adminAuthMiddleware,
    handler: async (request, reply) => {
      const query = z.object({
        page: z.coerce.number().int().positive().default(1),
        limit: z.coerce.number().int().min(1).max(100).default(20),
      }).safeParse(request.query);

      if (!query.success) {
        return reply.code(400).send({ error: 'Invalid query parameters' });
      }

      const result = await withdrawalService.listWithdrawals(query.data.page, query.data.limit);
      return reply.send(result);
    },
  });
}
