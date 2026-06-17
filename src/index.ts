import 'dotenv/config';
import { validateEnv } from './config/validate';
validateEnv();
import { buildServer } from './api/server';
import { connectDb, disconnectDb } from './db';
import { config } from './config';

async function main() {
  await connectDb();

  const server = buildServer();

  const address = await server.listen({
    port: config.port,
    host: '0.0.0.0',
  });

  server.log.info(`Server running at ${address}`);
  server.log.info(`Admin dashboard: ${address}/admin/`);
  server.log.info(`API docs: ${address}/api/v1/docs`);

  const shutdown = async () => {
    server.log.info('Shutting down...');
    await server.close();
    await disconnectDb();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
