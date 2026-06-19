import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { config } from './config';
import { authPlugin } from './plugins/auth';
import { storageRoutes } from './routes/storage';

const fastify = Fastify({
  logger: true,
});

// Register plugins
fastify.register(cors, {
  origin: config.corsOrigin,
  credentials: true,
  // CUSTOM: @fastify/corsのデフォルトはGET,HEAD,POSTのみで、
  // ストレージAPIで使うPATCH/DELETEを許可しないとプリフライトで弾かれてしまう
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
});

fastify.register(helmet);
fastify.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute',
});

fastify.register(swagger, {
  swagger: {
    info: {
      title: 'SawaraChats Storage API',
      description: 'Online storage API for SawaraChats',
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

fastify.register(multipart, {
  limits: {
    fileSize: 1024 * 1024 * 1024, // 1GB per file
  },
});

// Register authenticated storage routes
// CUSTOM: authPluginとstorageRoutesを同じ子コンテキストにネストして登録することで、
// fp()でフラット化された認証フックの適用範囲を/api/v1/storage配下に限定し、
// /health等の他ルートに認証を要求してしまわないようにする
fastify.register(async (instance) => {
  await instance.register(authPlugin);
  await instance.register(storageRoutes, { prefix: '/api/v1/storage' });
});

// Health check endpoint
fastify.get('/health', async () => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

const start = async () => {
  try {
    await fastify.listen({
      port: config.apiPort,
      host: config.apiHost,
    });
    console.log(`Storage API server listening on ${config.apiHost}:${config.apiPort}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();