import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import swagger from '@fastify/swagger';
import { timingSafeEqual } from 'crypto';
import path from 'path';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { FastifyAdapter } from '@bull-board/fastify';
import { withdrawalsRoutes } from './routes/withdrawals';
import { adminRoutes } from './routes/admin';
import { depositsRoutes } from './routes/deposits';
import { sweepQueue, withdrawalQueue } from '../workers/queue';
import { config } from '../config';
import pino from 'pino';

function bullboardSafeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function buildServer() {
  const server = Fastify({
    // trustProxy lets Fastify resolve request.ip from X-Forwarded-For set by nginx
    // nginx must strip/overwrite this header from untrusted clients
    trustProxy: true,
    logger: pino({
      level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    }),
  });

  // Swagger docs
  server.register(swagger, {
    openapi: {
      info: { title: 'CryptoPayment Gateway API', version: '1.0.0', description: 'Custodial crypto payment gateway' },
      servers: [{ url: '/api/v1' }],
      components: {
        securitySchemes: {
          apiKey: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
          adminSecret: { type: 'apiKey', in: 'header', name: 'X-Admin-Secret' },
        },
      },
    },
  });

  server.get('/api/v1/docs', async (_req, reply) => {
    reply.type('text/html').send(`<!doctype html>
<html>
  <head>
    <title>CryptoPayment Gateway — API Docs</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <script id="api-reference" data-url="/api/v1/openapi.json"></script>
    <script>
      document.getElementById('api-reference').dataset.configuration = JSON.stringify({
        theme: 'purple',
        layout: 'modern',
        defaultOpenAllTags: true,
      });
    </script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>`);
  });

  // BullMQ Board — uses dedicated BULLBOARD_PASSWORD, falls back to admin secret
  // Separate credential prevents admin secret from being shared with monitoring tools
  const boardAdapter = new FastifyAdapter();
  createBullBoard({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    queues: [new BullMQAdapter(sweepQueue) as any, new BullMQAdapter(withdrawalQueue) as any],
    serverAdapter: boardAdapter,
  });
  boardAdapter.setBasePath('/queues');
  server.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/queues')) return;
    const auth = request.headers['authorization'];
    if (auth?.startsWith('Basic ')) {
      const decoded = Buffer.from(auth.slice(6), 'base64').toString();
      const colonIdx = decoded.indexOf(':');
      if (colonIdx !== -1) {
        const password = decoded.slice(colonIdx + 1);
        const expected = config.admin.bullboardPassword || config.admin.secret;
        if (bullboardSafeCompare(password, expected)) return;
      }
    }
    reply.header('WWW-Authenticate', 'Basic realm="Queue Monitor"');
    return reply.code(401).send('Unauthorized');
  });
  server.register(boardAdapter.registerPlugin(), { prefix: '/queues', basePath: '/queues' });

  // Security middleware
  server.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        connectSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        frameSrc: ["'none'"],
        upgradeInsecureRequests: null,
      },
    },
  });

  const corsOrigin = config.corsOrigins;
  server.register(cors, {
    // Empty string = deny all cross-origin requests (safe default)
    // Set CORS_ORIGINS=https://yourapp.com in production
    origin: corsOrigin === '' ? false : corsOrigin === '*' ? true : corsOrigin.split(',').map((o) => o.trim()),
    credentials: true,
  });

  // Global rate limit — generous for most endpoints
  server.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
    keyGenerator: (request) => (request.headers['x-api-key'] as string) ?? request.ip,
  });

  // Serve static dashboards
  server.register(staticFiles, { root: path.join(process.cwd(), 'admin'), prefix: '/admin/' });
  server.register(staticFiles, { root: path.join(process.cwd(), 'client'), prefix: '/client/', decorateReply: false });
  server.register(staticFiles, { root: path.join(process.cwd(), 'test-client'), prefix: '/test/', decorateReply: false });
  server.register(staticFiles, { root: path.join(process.cwd(), 'docs'), prefix: '/docs/', decorateReply: false });

  server.get('/api/v1/openapi.json', async () => server.swagger());
  server.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  server.register(
    async (v1) => {
      // Tighter rate limit on withdrawal creation — financial endpoint
      v1.register(withdrawalsRoutes, { rateLimit: { max: 10, timeWindow: '1 minute' } });
      v1.register(adminRoutes);
      v1.register(depositsRoutes);
    },
    { prefix: '/api/v1' },
  );

  // Global error handler — never leak internal messages on 5xx
  server.setErrorHandler((error, _request, reply) => {
    server.log.error(error);
    const isOperational = error.statusCode != null && error.statusCode < 500;
    reply.code(error.statusCode ?? 500).send({
      error: isOperational ? error.message : 'Internal Server Error',
    });
  });

  return server;
}
