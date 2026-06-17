import { FastifyRequest, FastifyReply } from 'fastify';
import { timingSafeEqual } from 'crypto';
import { config } from '../../config';

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export async function adminAuthMiddleware(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  // Use request.ip which Fastify resolves from the TCP socket (with trustProxy)
  // Never trust X-Real-IP or X-Forwarded-For directly from the client layer
  const whitelist = config.admin.ipWhitelist;
  if (whitelist.length > 0) {
    const clientIp = request.ip;
    if (!whitelist.includes(clientIp)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
  }

  const secret = request.headers['x-admin-secret'] as string | undefined;
  if (!secret || !safeCompare(secret, config.admin.secret)) {
    return reply.code(403).send({ error: 'Forbidden' });
  }
}
