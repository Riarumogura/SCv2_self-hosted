import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { config } from './config';
import { authPlugin } from './plugins/auth';
import { albumRoutes } from './routes/album';

const fastify = Fastify({
  logger: true,
});

fastify.register(cors, {
  origin: config.corsOrigin,
  credentials: true,
  // CUSTOM: PUT/DELETEを使うためプリフライトで弾かれないよう明示する(calendar-apiと同様)
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
});

fastify.register(helmet);
fastify.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute',
});

fastify.register(swagger, {
  swagger: {
    info: {
      title: 'SawaraChats Album API',
      description: 'Server-wide album API for SawaraChats',
      version: '1.0.0',
    },
    host: config.apiHost,
    schemes: ['http'],
    consumes: ['application/json'],
    produces: ['application/json'],
  },
});

fastify.register(swaggerUi, {
  routePrefix: '/docs',
});

// CUSTOM: calendar-apiと同様、authPluginとalbumRoutesを同じ子コンテキストに
// ネストして登録し、認証フックの適用範囲を/api/v1配下に限定する(/health等を除外)
fastify.register(async (instance) => {
  await instance.register(authPlugin);
  await instance.register(albumRoutes, { prefix: '/api/v1' });
});

fastify.get('/health', async () => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

const start = async () => {
  try {
    await fastify.listen({
      port: config.apiPort,
      host: config.apiHost,
    });
    console.log(`Album API server listening on ${config.apiHost}:${config.apiPort}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
