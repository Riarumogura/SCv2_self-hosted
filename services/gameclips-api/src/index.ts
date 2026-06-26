import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import websocket from '@fastify/websocket';
import { config } from './config';
import { authPlugin } from './plugins/auth';
import { gameClipsRoutes } from './routes/gameclips';
import { gameClipsSocketRoutes } from './routes/socket';

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
      title: 'SawaraChats GameClips API',
      description: 'Server-wide game clip posting API for SawaraChats',
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

fastify.register(websocket);

// CUSTOM: album-apiと同様、authPluginとgameClipsRoutesを同じ子コンテキストに
// ネストして登録し、認証フックの適用範囲を/api/v1配下に限定する(/health等を除外)
fastify.register(async (instance) => {
  await instance.register(authPlugin);
  await instance.register(gameClipsRoutes, { prefix: '/api/v1' });
});

// CUSTOM: WebSocketルートはヘッダー前提のauthPluginを適用せず、クエリパラメータの
// tokenを使った独自認証(authenticateUser)で行うため、authPluginとは別の子コンテキストで登録する
fastify.register(async (instance) => {
  await instance.register(gameClipsSocketRoutes, { prefix: '/api/v1' });
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
    console.log(`GameClips API server listening on ${config.apiHost}:${config.apiPort}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
