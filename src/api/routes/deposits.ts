import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Network } from '@prisma/client';
import { adminAuthMiddleware } from '../middleware/auth';
import { userWalletService } from '../../services/userWalletService';
import { SUPPORTED_TOKENS } from '../../config';
import { prisma } from '../../db';

const addressSchema = z.object({
  userId: z.string().min(1).max(255),
  network: z.nativeEnum(Network),
});

const listQuerySchema = z.object({
  userId: z.string().optional(),
  network: z.nativeEnum(Network).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export async function depositsRoutes(fastify: FastifyInstance): Promise<void> {
  // Get or create a permanent deposit address for a user (accepts all tokens on that network)
  fastify.post('/deposits/address', {
    preHandler: adminAuthMiddleware,
    handler: async (request, reply) => {
      const body = addressSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: 'Validation error', details: body.error.flatten() });
      }

      const { userId, network } = body.data;

      try {
        const wallet = await userWalletService.getOrCreate(userId, network);
        return reply.send({
          data: {
            userId,
            network,
            address: wallet.address,
            supportedTokens: SUPPORTED_TOKENS[network],
            createdAt: wallet.createdAt.toISOString(),
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Internal error';
        return reply.code(500).send({ error: message });
      }
    },
  });

  // List all deposit addresses
  fastify.get('/deposits/addresses', {
    preHandler: adminAuthMiddleware,
    handler: async (request, reply) => {
      const query = listQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.code(400).send({ error: 'Invalid query parameters' });
      }

      const { userId, network, page, limit } = query.data;

      const where = {
        ...(userId && { userId }),
        ...(network && { network }),
      };

      const [wallets, total] = await Promise.all([
        prisma.userWallet.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.userWallet.count({ where }),
      ]);

      return reply.send({
        data: wallets.map((w) => ({
          userId: w.userId,
          network: w.network,
          address: w.address,
          supportedTokens: SUPPORTED_TOKENS[w.network],
          createdAt: w.createdAt.toISOString(),
        })),
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      });
    },
  });
}
