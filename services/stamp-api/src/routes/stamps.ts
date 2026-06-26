import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { MongoDBService } from '../services/mongodb.service';
import { MinioService } from '../services/minio.service';
import { config } from '../config';

const createStampFieldsSchema = z.object({
  name: z.string().min(1).max(32),
  width: z.coerce.number().int().positive().max(1024),
  height: z.coerce.number().int().positive().max(1024),
  durationMs: z.coerce.number().int().positive().max(10_000),
});

// CUSTOM: stamp-apiは自分が公開されているCaddy上のURL(http://.../stamps/api/v1)を
// 知らないため、絶対URLはここでは作らず id だけを返す。フロントエンドのstamp.tsが
// 既知のbaseUrlとidからurlを組み立てる(CustomEmoji.tsxがautumn URL+idで
// emoji.urlを組み立てているのと同じ考え方)。
function stampToResponse(stamp: { _id: string; name: string; width: number; height: number; durationMs: number; fileSize: number; createdAt: Date; creatorId: string }) {
  return {
    id: stamp._id,
    name: stamp.name,
    width: stamp.width,
    height: stamp.height,
    durationMs: stamp.durationMs,
    fileSize: stamp.fileSize,
    createdAt: stamp.createdAt,
    creatorId: stamp.creatorId,
  };
}

/**
 * Authenticated CRUD routes for stamps (create/list/get/delete).
 * The unauthenticated byte-serving route lives separately in stampFile.ts,
 * since <img src> tags and january's embed fetcher can't attach the
 * X-Session-Token/X-Server-Id headers this plugin requires.
 */
export function createStampRoutes(mongoService: MongoDBService, minioService: MinioService): FastifyPluginAsync {
  return async (fastify) => {
    // Create a stamp (multipart: file=webp blob, name, width, height, durationMs)
    fastify.post('/', async (request, reply) => {
      if (!request.user) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }

      const { serverId, id: creatorId } = request.user;

      let fileBuffer: Buffer | undefined;
      let contentType = '';
      const fields: Record<string, string> = {};

      try {
        for await (const part of request.parts()) {
          if (part.type === 'file') {
            fileBuffer = await part.toBuffer();
            contentType = part.mimetype || '';
          } else if (typeof part.value === 'string') {
            fields[part.fieldname] = part.value;
          }
        }
      } catch (error) {
        console.error('Error parsing stamp upload:', error);
        return reply.code(400).send({ error: 'Failed to parse upload' });
      }

      if (!fileBuffer) {
        return reply.code(400).send({ error: 'File is required' });
      }

      if (contentType !== 'image/webp') {
        return reply.code(400).send({ error: 'Only image/webp stamps are accepted' });
      }

      if (fileBuffer.length > config.maxStampFileSizeBytes) {
        return reply.code(413).send({
          error: 'Stamp file too large',
          limit: config.maxStampFileSizeBytes,
        });
      }

      const parsed = createStampFieldsSchema.safeParse(fields);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid request fields', details: parsed.error.issues });
      }

      const stampCount = await mongoService.countStamps(serverId);
      if (stampCount >= config.maxStampsPerServer) {
        return reply.code(403).send({
          error: 'Stamp limit exceeded',
          limit: config.maxStampsPerServer,
        });
      }

      try {
        const stamp = await mongoService.createStamp({
          serverId,
          creatorId,
          name: parsed.data.name,
          width: parsed.data.width,
          height: parsed.data.height,
          durationMs: parsed.data.durationMs,
          fileSize: fileBuffer.length,
        });

        await minioService.uploadStamp(stamp.objectName, fileBuffer, contentType);

        return reply.code(201).send(stampToResponse(stamp));
      } catch (error) {
        console.error('Error creating stamp:', error);
        return reply.code(500).send({ error: 'Failed to create stamp' });
      }
    });

    // List stamps for the current server
    fastify.get('/', async (request, reply) => {
      if (!request.user) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }

      const { serverId } = request.user;

      try {
        const stamps = await mongoService.listStamps(serverId);
        return reply.send({
          stamps: stamps.map(stampToResponse),
          count: stamps.length,
          limit: config.maxStampsPerServer,
        });
      } catch (error) {
        console.error('Error listing stamps:', error);
        return reply.code(500).send({ error: 'Failed to list stamps' });
      }
    });

    // Get a single stamp's metadata
    fastify.get('/:stampId', async (request, reply) => {
      if (!request.user) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }

      const { serverId } = request.user;
      const { stampId } = request.params as { stampId: string };

      const stamp = await mongoService.getStamp(stampId);
      if (!stamp || stamp.serverId !== serverId) {
        return reply.code(404).send({ error: 'Stamp not found' });
      }

      return reply.send(stampToResponse(stamp));
    });

    // Delete a stamp
    fastify.delete('/:stampId', async (request, reply) => {
      if (!request.user) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }

      const { serverId } = request.user;
      const { stampId } = request.params as { stampId: string };

      const stamp = await mongoService.getStamp(stampId);
      if (!stamp || stamp.serverId !== serverId) {
        return reply.code(404).send({ error: 'Stamp not found' });
      }

      try {
        await minioService.deleteFile(stamp.objectName).catch(() => undefined);
        await mongoService.deleteStamp(stampId);
        return reply.code(204).send();
      } catch (error) {
        console.error('Error deleting stamp:', error);
        return reply.code(500).send({ error: 'Failed to delete stamp' });
      }
    });
  };
}
