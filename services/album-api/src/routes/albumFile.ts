import { FastifyPluginAsync } from 'fastify';
import { MongoDBService } from '../services/mongodb.service';
import { MinioService } from '../services/minio.service';

/**
 * CUSTOM: このルートは意図的に認証プラグインの外側(index.tsでauthPluginを
 * 登録していない別グループ)に登録する。<img src>/<video src>タグはX-Session-Token/
 * X-Server-Idを付与できないため、写真・動画の実バイトを返すエンドポイントだけは
 * 無認証でなければ機能しない。Autumnのattachments URLが無認証であるのと同じ
 * 信頼モデル(fileIdの推測困難性で保護)。fileIdは32文字のランダムhex
 * (mongodb.service.tsのgenerateFileId)なので、総当たりは現実的でない。
 */
export function createAlbumFileRoutes(
  mongoService: MongoDBService,
  minioService: MinioService,
): FastifyPluginAsync {
  return async (fastify) => {
    fastify.get('/photos/:fileId/file', async (request, reply) => {
      const { fileId } = request.params as { fileId: string };

      const photo = await mongoService.getPhotoByFileId(fileId);
      if (!photo) return reply.code(404).send({ error: 'Photo not found' });

      try {
        const metadata = await minioService.getFileMetadata(photo.objectName);
        const stream = await minioService.getObjectStream(photo.objectName);

        reply.header('Content-Type', metadata.contentType);
        reply.header('Cache-Control', 'public, max-age=31536000, immutable');
        return reply.send(stream);
      } catch (error) {
        console.error('Error serving album photo file:', error);
        return reply.code(404).send({ error: 'Photo file not found' });
      }
    });
  };
}
