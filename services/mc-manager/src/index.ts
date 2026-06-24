import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import { config } from './config';
import { authPlugin } from './plugins/auth';
import { minecraftRoutes } from './routes/minecraft';
import { minecraftFileRoutes } from './routes/minecraft-files';

const fastify = Fastify({
  logger: true,
});

// CUSTOM: zip展開(unzipper)はアップロードされた任意のファイルをパースするため、
// サードパーティライブラリ内部のストリームが想定外のタイミングで'error'を出し、
// リスナーが外れているとプロセス全体がクラッシュすることがある(実際に発生し、
// zip-extract.service.ts側の主因は修正済みだが、多数ファイルを含む実サーバーzipの
// パースは経路が多く同種の取りこぼしが今後も起こりうるため、最後の保険として
// プロセスを落とさずログに残すだけにする。個々のリクエストの異常終了は
// ハンドラ側のtry/catchで処理する)。
process.on('uncaughtException', (err) => {
  fastify.log.error({ err }, 'uncaughtException (process kept alive)');
});
process.on('unhandledRejection', (reason) => {
  fastify.log.error({ reason }, 'unhandledRejection (process kept alive)');
});

fastify.register(cors, {
  origin: config.corsOrigin,
  credentials: true,
  // CUSTOM: storage-api/calendar-apiと同様、PUT/DELETEを使うためプリフライトで弾かれないよう明示する
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
});

fastify.register(helmet);
fastify.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute',
});

fastify.register(websocket);

// CUSTOM: 既存サーバーファイル(zip)のアップロード用。ユーザー確認済みの上限10GBを
// fileSizeに設定する(storage-apiの1GB設定と同じ位置づけ)。Fastify本体のbodyLimitは
// multipartには適用されない(busboyベースの別パーサーのため)ので変更不要。
fastify.register(multipart, {
  limits: {
    fileSize: 10 * 1024 * 1024 * 1024,
  },
});

fastify.register(swagger, {
  swagger: {
    info: {
      title: 'SawaraChats Minecraft Manager API',
      description: 'Minecraft server management API for SawaraChats',
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

// CUSTOM: storage-api/calendar-apiと同様、authPluginとminecraftRoutesを同じ子コンテキストに
// ネストして登録し、認証フックの適用範囲を/api/v1配下に限定する(/health等を除外)
fastify.register(async (instance) => {
  await instance.register(authPlugin);
  await instance.register(minecraftRoutes, { prefix: '/api/v1' });
  await instance.register(minecraftFileRoutes, { prefix: '/api/v1' });
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
    console.log(`Minecraft Manager API server listening on ${config.apiHost}:${config.apiPort}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
