import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { config } from './config';
import { authPlugin } from './plugins/auth';
import { calendarRoutes } from './routes/calendar';

const fastify = Fastify({
  logger: true,
});

fastify.register(cors, {
  origin: config.corsOrigin,
  credentials: true,
  // CUSTOM: storage-apiと同様、PUT/DELETEを使うためプリフライトで弾かれないよう明示する
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
      title: 'SawaraChats Calendar API',
      description: 'Shared calendar API for SawaraChats',
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

// CUSTOM: storage-apiと同様、authPluginとcalendarRoutesを同じ子コンテキストに
// ネストして登録し、認証フックの適用範囲を/api/v1配下に限定する(/health等を除外)
fastify.register(async (instance) => {
  await instance.register(authPlugin);
  await instance.register(calendarRoutes, { prefix: '/api/v1' });
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
    console.log(`Calendar API server listening on ${config.apiHost}:${config.apiPort}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
