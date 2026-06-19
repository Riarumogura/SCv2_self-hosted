import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
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