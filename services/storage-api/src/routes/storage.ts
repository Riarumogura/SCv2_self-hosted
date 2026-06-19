import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import axios from 'axios';
import { MongoDBService } from '../services/mongodb.service';
import { MinioService } from '../services/minio.service';
import { config } from '../config';

const createStorageSchema = z.object({
  name: z.string().min(1).max(100),
  sizeLimit: z.number().int().positive().max(1024 * 1024 * 1024 * 1024), // 1TB max
});

const updateStorageSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  sizeLimit: z.number().int().positive().max(1024 * 1024 * 1024 * 1024).optional(), // 1TB max
});

const pathBodySchema = z.object({
  path: z.string().min(1).max(1024),
});

const moveFolderSchema = z.object({
  path: z.string().min(1).max(1024),
  newPath: z.string().min(1).max(1024),
});

const copyFileSchema = z.object({
  sourceUrl: z.string().url(),
  destinationPath: z.string().min(1).max(1024),
});

/**
 * CUSTOM: クライアント指定のパスを正規化し、`..` 等によるディレクトリトラバーサルを防ぐ
 */
function sanitizePath(path: string): string {
  return path
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .join('/');
}

export const storageRoutes: FastifyPluginAsync = async (fastify) => {
  const mongoService = new MongoDBService();
  const minioService = new MinioService();

  // Initialize services
  fastify.addHook('onReady', async () => {
    await mongoService.connect();
    await minioService.ensureBucket();
  });

  fastify.addHook('onClose', async () => {
    await mongoService.disconnect();
  });

  // Create storage
  fastify.post('/', async (request, reply) => {
    if (!request.user) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const parsed = createStorageSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request body', details: parsed.error.issues });
    }

    const { name, sizeLimit } = parsed.data;
    const { serverId } = request.user;

      // Check server storage limit
      const canCreate = await mongoService.checkServerStorageLimit(serverId, 0);
      if (!canCreate) {
        return reply.code(403).send({ 
          error: 'Server storage limit exceeded',
          limit: Number(config.defaultServerStorageLimit),
        });
      }

    try {
      const storageConfig = await mongoService.createStorageConfig(serverId, name, sizeLimit);
      
      return reply.code(201).send({
        id: storageConfig.storageId,
        name: storageConfig.name,
        sizeLimit: storageConfig.sizeLimit,
        createdAt: storageConfig.createdAt,
      });
    } catch (error) {
      console.error('Error creating storage:', error);
      return reply.code(500).send({ error: 'Failed to create storage' });
    }
  });

  // List storages
  fastify.get('/', async (request, reply) => {
    if (!request.user) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const { serverId } = request.user;

    try {
      const storageConfigs = await mongoService.listStorageConfigs(serverId);
      
      // Get usage for each storage
      const storagesWithUsage = await Promise.all(
        storageConfigs.map(async (config) => {
          const usage = await mongoService.getStorageUsage(serverId, config.storageId);
          const size = await minioService.getStorageSize(serverId, config.storageId);
          
          return {
            id: config.storageId,
            name: config.name,
            sizeLimit: config.sizeLimit,
            usedSize: usage?.totalSize || size,
            fileCount: usage?.fileCount || 0,
            createdAt: config.createdAt,
            updatedAt: config.updatedAt,
          };
        })
      );

      return reply.send(storagesWithUsage);
    } catch (error) {
      console.error('Error listing storages:', error);
      return reply.code(500).send({ error: 'Failed to list storages' });
    }
  });

  // Get storage details
  fastify.get('/:storageId', async (request, reply) => {
    if (!request.user) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const { serverId } = request.user;
    const { storageId } = request.params as { storageId: string };

    try {
      const storageConfig = await mongoService.getStorageConfig(serverId, storageId);
      if (!storageConfig) {
        return reply.code(404).send({ error: 'Storage not found' });
      }

      const usage = await mongoService.getStorageUsage(serverId, storageId);
      const size = await minioService.getStorageSize(serverId, storageId);

      return reply.send({
        id: storageConfig.storageId,
        name: storageConfig.name,
        sizeLimit: storageConfig.sizeLimit,
        usedSize: usage?.totalSize || size,
        fileCount: usage?.fileCount || 0,
        createdAt: storageConfig.createdAt,
        updatedAt: storageConfig.updatedAt,
      });
    } catch (error) {
      console.error('Error getting storage:', error);
      return reply.code(500).send({ error: 'Failed to get storage' });
    }
  });

  // Update storage
  fastify.patch('/:storageId', async (request, reply) => {
    if (!request.user) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const parsed = updateStorageSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request body', details: parsed.error.issues });
    }

    const { serverId } = request.user;
    const { storageId } = request.params as { storageId: string };
    const updates = parsed.data;

    try {
      const storageConfig = await mongoService.getStorageConfig(serverId, storageId);
      if (!storageConfig) {
        return reply.code(404).send({ error: 'Storage not found' });
      }

      // If updating sizeLimit, check if new limit is not less than current usage
      if (updates.sizeLimit !== undefined) {
        const usage = await mongoService.getStorageUsage(serverId, storageId);
        const currentUsage = usage?.totalSize || 0;
        
        if (currentUsage > updates.sizeLimit) {
          return reply.code(400).send({ 
            error: 'New size limit is less than current usage',
            currentUsage,
            newLimit: updates.sizeLimit,
          });
        }
      }

      const updatedConfig = await mongoService.updateStorageConfig(serverId, storageId, updates);
      if (!updatedConfig) {
        return reply.code(500).send({ error: 'Failed to update storage' });
      }

      return reply.send({
        id: updatedConfig.storageId,
        name: updatedConfig.name,
        sizeLimit: updatedConfig.sizeLimit,
        updatedAt: updatedConfig.updatedAt,
      });
    } catch (error) {
      console.error('Error updating storage:', error);
      return reply.code(500).send({ error: 'Failed to update storage' });
    }
  });

  // Delete storage
  fastify.delete('/:storageId', async (request, reply) => {
    if (!request.user) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const { serverId } = request.user;
    const { storageId } = request.params as { storageId: string };

    try {
      const storageConfig = await mongoService.getStorageConfig(serverId, storageId);
      if (!storageConfig) {
        return reply.code(404).send({ error: 'Storage not found' });
      }

      // Delete all files from MinIO
      await minioService.deleteFolder(serverId, storageId, '');

      // Delete from MongoDB
      await mongoService.deleteStorageConfig(serverId, storageId);
      await mongoService.deleteStorageUsage(serverId, storageId);

      return reply.code(204).send();
    } catch (error) {
      console.error('Error deleting storage:', error);
      return reply.code(500).send({ error: 'Failed to delete storage' });
    }
  });

  // List files and folders at a path (one level, non-recursive)
  fastify.get('/:storageId/files', async (request, reply) => {
    if (!request.user) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const { serverId } = request.user;
    const { storageId } = request.params as { storageId: string };
    const { path } = request.query as { path?: string };

    const storageConfig = await mongoService.getStorageConfig(serverId, storageId);
    if (!storageConfig) {
      return reply.code(404).send({ error: 'Storage not found' });
    }

    try {
      const entries = await minioService.listFilesAndFolders(
        serverId,
        storageId,
        path ? sanitizePath(path) : ''
      );
      return reply.send(entries);
    } catch (error) {
      console.error('Error listing files:', error);
      return reply.code(500).send({ error: 'Failed to list files' });
    }
  });

  // Upload a file (multipart/form-data: fields "file" and "path")
  fastify.post('/:storageId/files', async (request, reply) => {
    if (!request.user) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const { serverId } = request.user;
    const { storageId } = request.params as { storageId: string };

    const storageConfig = await mongoService.getStorageConfig(serverId, storageId);
    if (!storageConfig) {
      return reply.code(404).send({ error: 'Storage not found' });
    }

    let destinationPath = '';
    let fileBuffer: Buffer | undefined;
    let contentType = 'application/octet-stream';

    try {
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          fileBuffer = await part.toBuffer();
          contentType = part.mimetype || contentType;
          if (!destinationPath) {
            destinationPath = part.filename;
          }
        } else if (part.fieldname === 'path' && typeof part.value === 'string') {
          destinationPath = part.value;
        }
      }
    } catch (error) {
      console.error('Error parsing upload:', error);
      return reply.code(400).send({ error: 'Failed to parse upload' });
    }

    if (!fileBuffer) {
      return reply.code(400).send({ error: 'File is required' });
    }

    const safePath = sanitizePath(destinationPath);
    if (!safePath) {
      return reply.code(400).send({ error: 'Invalid file path' });
    }

    const canUpload =
      (await mongoService.checkStorageLimit(serverId, storageId, fileBuffer.length)) &&
      (await mongoService.checkServerStorageLimit(serverId, fileBuffer.length));
    if (!canUpload) {
      return reply.code(403).send({ error: 'Storage limit exceeded' });
    }

    try {
      await minioService.uploadFile(serverId, storageId, safePath, fileBuffer, contentType);
      await mongoService.updateStorageUsage(serverId, storageId, fileBuffer.length, 1);

      return reply.code(201).send({
        name: safePath.split('/').pop(),
        path: safePath,
        size: fileBuffer.length,
        type: contentType,
        lastModified: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Error uploading file:', error);
      return reply.code(500).send({ error: 'Failed to upload file' });
    }
  });

  // Download a file
  fastify.get('/:storageId/files/download', async (request, reply) => {
    if (!request.user) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const { serverId } = request.user;
    const { storageId } = request.params as { storageId: string };
    const { path } = request.query as { path?: string };

    if (!path) {
      return reply.code(400).send({ error: 'path query parameter is required' });
    }

    const storageConfig = await mongoService.getStorageConfig(serverId, storageId);
    if (!storageConfig) {
      return reply.code(404).send({ error: 'Storage not found' });
    }

    const safePath = sanitizePath(path);
    const objectName = `server_${serverId}/storage_${storageId}/${safePath}`;

    try {
      const metadata = await minioService.getFileMetadata(objectName);
      const stream = await minioService.getObjectStream(objectName);

      reply.header('Content-Type', metadata.contentType);
      reply.header(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(safePath.split('/').pop() || 'file')}"`
      );
      return reply.send(stream);
    } catch (error) {
      console.error('Error downloading file:', error);
      return reply.code(404).send({ error: 'File not found' });
    }
  });

  // Copy a chat attachment URL into storage
  fastify.post('/:storageId/files/copy', async (request, reply) => {
    if (!request.user) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const { serverId } = request.user;
    const { storageId } = request.params as { storageId: string };

    const parsed = copyFileSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request body', details: parsed.error.issues });
    }

    const storageConfig = await mongoService.getStorageConfig(serverId, storageId);
    if (!storageConfig) {
      return reply.code(404).send({ error: 'Storage not found' });
    }

    const safePath = sanitizePath(parsed.data.destinationPath);
    if (!safePath) {
      return reply.code(400).send({ error: 'Invalid destination path' });
    }

    try {
      const response = await axios.get(parsed.data.sourceUrl, { responseType: 'arraybuffer' });
      const fileBuffer = Buffer.from(response.data);
      const contentType =
        (response.headers['content-type'] as string | undefined) || 'application/octet-stream';

      const canUpload =
        (await mongoService.checkStorageLimit(serverId, storageId, fileBuffer.length)) &&
        (await mongoService.checkServerStorageLimit(serverId, fileBuffer.length));
      if (!canUpload) {
        return reply.code(403).send({ error: 'Storage limit exceeded' });
      }

      await minioService.uploadFile(serverId, storageId, safePath, fileBuffer, contentType);
      await mongoService.updateStorageUsage(serverId, storageId, fileBuffer.length, 1);

      return reply.code(201).send({
        name: safePath.split('/').pop(),
        path: safePath,
        size: fileBuffer.length,
        type: contentType,
        lastModified: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Error copying file into storage:', error);
      return reply.code(500).send({ error: 'Failed to save file to storage' });
    }
  });

  // Delete a file
  fastify.delete('/:storageId/files', async (request, reply) => {
    if (!request.user) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const { serverId } = request.user;
    const { storageId } = request.params as { storageId: string };

    const parsed = pathBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request body', details: parsed.error.issues });
    }

    const storageConfig = await mongoService.getStorageConfig(serverId, storageId);
    if (!storageConfig) {
      return reply.code(404).send({ error: 'Storage not found' });
    }

    const safePath = sanitizePath(parsed.data.path);
    const objectName = `server_${serverId}/storage_${storageId}/${safePath}`;

    try {
      const metadata = await minioService.getFileMetadata(objectName).catch(() => null);
      await minioService.deleteFile(objectName);

      if (metadata) {
        await mongoService.updateStorageUsage(serverId, storageId, -metadata.size, -1);
      }

      return reply.code(204).send();
    } catch (error) {
      console.error('Error deleting file:', error);
      return reply.code(500).send({ error: 'Failed to delete file' });
    }
  });

  // Create a folder
  fastify.post('/:storageId/folders', async (request, reply) => {
    if (!request.user) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const { serverId } = request.user;
    const { storageId } = request.params as { storageId: string };

    const parsed = pathBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request body', details: parsed.error.issues });
    }

    const storageConfig = await mongoService.getStorageConfig(serverId, storageId);
    if (!storageConfig) {
      return reply.code(404).send({ error: 'Storage not found' });
    }

    const safePath = sanitizePath(parsed.data.path);
    if (!safePath) {
      return reply.code(400).send({ error: 'Invalid folder path' });
    }

    try {
      await minioService.createFolder(serverId, storageId, safePath);
      return reply.code(201).send({ path: safePath });
    } catch (error) {
      console.error('Error creating folder:', error);
      return reply.code(500).send({ error: 'Failed to create folder' });
    }
  });

  // Rename or move a folder
  fastify.patch('/:storageId/folders', async (request, reply) => {
    if (!request.user) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const { serverId } = request.user;
    const { storageId } = request.params as { storageId: string };

    const parsed = moveFolderSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request body', details: parsed.error.issues });
    }

    const storageConfig = await mongoService.getStorageConfig(serverId, storageId);
    if (!storageConfig) {
      return reply.code(404).send({ error: 'Storage not found' });
    }

    const safePath = sanitizePath(parsed.data.path);
    const newSafePath = sanitizePath(parsed.data.newPath);
    if (!safePath || !newSafePath) {
      return reply.code(400).send({ error: 'Invalid folder path' });
    }
    if (newSafePath === safePath || newSafePath.startsWith(`${safePath}/`)) {
      return reply.code(400).send({ error: 'Cannot move a folder into itself' });
    }

    try {
      await minioService.renameFolder(serverId, storageId, safePath, newSafePath);
      return reply.send({ path: newSafePath });
    } catch (error) {
      console.error('Error renaming folder:', error);
      return reply.code(500).send({ error: 'Failed to rename folder' });
    }
  });

  // Delete a folder and everything inside it
  fastify.delete('/:storageId/folders', async (request, reply) => {
    if (!request.user) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const { serverId } = request.user;
    const { storageId } = request.params as { storageId: string };

    const parsed = pathBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request body', details: parsed.error.issues });
    }

    const storageConfig = await mongoService.getStorageConfig(serverId, storageId);
    if (!storageConfig) {
      return reply.code(404).send({ error: 'Storage not found' });
    }

    const safePath = sanitizePath(parsed.data.path);
    if (!safePath) {
      return reply.code(400).send({ error: 'Invalid folder path' });
    }

    try {
      const { totalSize, fileCount } = await minioService.deleteFolder(serverId, storageId, safePath);
      if (fileCount > 0) {
        await mongoService.updateStorageUsage(serverId, storageId, -totalSize, -fileCount);
      }
      return reply.code(204).send();
    } catch (error) {
      console.error('Error deleting folder:', error);
      return reply.code(500).send({ error: 'Failed to delete folder' });
    }
  });

  // Get server storage limit info
  fastify.get('/server/limits', async (request, reply) => {
    if (!request.user) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const { serverId } = request.user;

    try {
      const serverTotalUsage = await mongoService.getServerTotalUsage(serverId);
      const serverLimit = Number(config.defaultServerStorageLimit);

      return reply.send({
        used: serverTotalUsage,
        limit: serverLimit,
        available: serverLimit - serverTotalUsage,
        percentage: Math.round((serverTotalUsage / serverLimit) * 100),
      });
    } catch (error) {
      console.error('Error getting server limits:', error);
      return reply.code(500).send({ error: 'Failed to get server limits' });
    }
  });
};