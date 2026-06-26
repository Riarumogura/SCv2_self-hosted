import { FastifyPluginAsync } from 'fastify';
import { MongoDBService } from '../services/mongodb.service';
import { MinioService } from '../services/minio.service';

/**
 * CUSTOM: このルートは意図的に認証プラグインの外側(index.tsでauthPluginを
 * 登録していない別グループ)に登録する。<img src>タグやjanuaryのEmbed取得は
 * X-Session-Token/X-Server-Idを付与できないため、スタンプの実バイトを返す
 * エンドポイントだけは無認証でなければ機能しない。autumnのemoji.urlや
 * TenorのGIF URLが無認証であるのと同じ信頼モデル(IDの推測困難性で保護)。
 * stampIdは32文字のランダムhex(mongodb.service.tsのgenerateStampId)なので、
 * 総当たりは現実的でない。
 */
export function createStampFileRoutes(mongoService: MongoDBService, minioService: MinioService): FastifyPluginAsync {
  return async (fastify) => {
    fastify.get('/:stampId/file', async (request, reply) => {
      const { stampId } = request.params as { stampId: string };

      const stamp = await mongoService.getStamp(stampId);
      if (!stamp) {
        return reply.code(404).send({ error: 'Stamp not found' });
      }

      try {
        const metadata = await minioService.getFileMetadata(stamp.objectName);
        const stream = await minioService.getObjectStream(stamp.objectName);

        reply.header('Content-Type', metadata.contentType);
        reply.header('Cache-Control', 'public, max-age=31536000, immutable');
        return reply.send(stream);
      } catch (error) {
        console.error('Error serving stamp file:', error);
        return reply.code(404).send({ error: 'Stamp file not found' });
      }
    });
  };
}
