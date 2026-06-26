import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { config } from './config';
import { authPlugin } from './plugins/auth';
import { createAlbumRoutes } from './routes/album';
import { createAlbumFileRoutes } from './routes/albumFile';
import { MongoDBService } from './services/mongodb.service';
import { MinioService } from './services/minio.service';

const fastify = Fastify({
  logger: true,
});

const mongoService = new MongoDBService();
const minioService = new MinioService();

fastify.register(cors, {
  origin: config.corsOrigin,
  credentials: true,
  // CUSTOM: PUT/DELETEを使うためプリフライトで弾かれないよう明示する(calendar-apiと同様)
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
});

// CUSTOM: @fastify/helmetのデフォルトはCross-Origin-Resource-Policy: same-originを
// 全レスポンスに付与する。/photos/:fileId/fileはフロントエンド(別オリジン)から
// <img src>/<video src>で直接読み込まれることが前提のため、デフォルトのままだと
// ブラウザがnet::ERR_BLOCKED_BY_RESPONSE (NotSameOrigin)で読み込みを拒否してしまう
// (stamp-apiで先に踏んだ既知の問題と同種)
fastify.register(helmet, {
  crossOriginResourcePolicy: { policy: 'cross-origin' },
});
fastify.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute',
});

fastify.register(multipart, {
  limits: {
    fileSize: config.maxFileSizeBytes,
  },
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

fastify.addHook('onReady', async () => {
  await mongoService.connect();
  await minioService.ensureBucket();
});

fastify.addHook('onClose', async () => {
  await mongoService.disconnect();
});

// CUSTOM: calendar-apiと同様、authPluginとalbumRoutesを同じ子コンテキストに
// ネストして登録し、認証フックの適用範囲を/api/v1配下のアルバムCRUD操作に限定する。
// /photos/:fileId/fileと/healthは認証なしの別グループ(stamp-apiと同じパターン)。
fastify.register(async (instance) => {
  await instance.register(authPlugin);
  await instance.register(createAlbumRoutes(mongoService, minioService), { prefix: '/api/v1' });
});

fastify.register(createAlbumFileRoutes(mongoService, minioService), { prefix: '/api/v1' });

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
