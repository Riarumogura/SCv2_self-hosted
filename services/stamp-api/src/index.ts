import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { config } from './config';
import { authPlugin } from './plugins/auth';
import { createStampRoutes } from './routes/stamps';
import { createStampFileRoutes } from './routes/stampFile';
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
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
});

// CUSTOM: @fastify/helmetのデフォルトはCross-Origin-Resource-Policy: same-originを
// 全レスポンスに付与する。stamp-apiはフロントエンド(別オリジン)から<img src>や
// fetchで直接読み込まれることが前提のAPIのため、デフォルトのままだとブラウザが
// net::ERR_BLOCKED_BY_RESPONSE (NotSameOrigin) で読み込みを拒否してしまう
// (/:stampId/fileの<img>表示が真っ白になる不具合の原因だった)。
fastify.register(helmet, {
  crossOriginResourcePolicy: { policy: 'cross-origin' },
});
fastify.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute',
});

fastify.register(multipart, {
  limits: {
    // CUSTOM: クライアントは既にffmpeg.wasmでアニメーションWebPに変換済みの
    // 小さいファイルしか送らない。多少の余裕を持たせつつ、上限は
    // config.maxStampFileSizeBytesの実チェックで厳密に行う
    fileSize: 5 * 1024 * 1024, // 5MB
  },
});

fastify.addHook('onReady', async () => {
  await mongoService.connect();
  await minioService.ensureBucket();
});

fastify.addHook('onClose', async () => {
  await mongoService.disconnect();
});

// CUSTOM: authPluginとstampRoutesを同じ子コンテキストにネストして登録することで、
// fp()でフラット化された認証フックの適用範囲を/api/v1/stamps配下の
// create/list/get/delete操作に限定する。/:stampId/fileと/healthは別グループ。
fastify.register(async (instance) => {
  await instance.register(authPlugin);
  await instance.register(createStampRoutes(mongoService, minioService), { prefix: '/api/v1/stamps' });
});

fastify.register(createStampFileRoutes(mongoService, minioService), { prefix: '/api/v1/stamps' });

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
    console.log(`Stamp API server listening on ${config.apiHost}:${config.apiPort}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
