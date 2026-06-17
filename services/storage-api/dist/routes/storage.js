"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.storageRoutes = void 0;
const zod_1 = require("zod");
const mongodb_service_1 = require("../services/mongodb.service");
const minio_service_1 = require("../services/minio.service");
const config_1 = require("../config");
const createStorageSchema = zod_1.z.object({
    name: zod_1.z.string().min(1).max(100),
    sizeLimit: zod_1.z.number().int().positive().max(1024 * 1024 * 1024 * 1024),
});
const updateStorageSchema = zod_1.z.object({
    name: zod_1.z.string().min(1).max(100).optional(),
    sizeLimit: zod_1.z.number().int().positive().max(1024 * 1024 * 1024 * 1024).optional(),
});
const storageRoutes = async (fastify) => {
    const mongoService = new mongodb_service_1.MongoDBService();
    const minioService = new minio_service_1.MinioService();
    fastify.addHook('onReady', async () => {
        await mongoService.connect();
        await minioService.ensureBucket();
    });
    fastify.addHook('onClose', async () => {
        await mongoService.disconnect();
    });
    fastify.post('/', {
        schema: {
            body: createStorageSchema,
        },
    }, async (request, reply) => {
        if (!request.user) {
            return reply.code(401).send({ error: 'Unauthorized' });
        }
        const { name, sizeLimit } = request.body;
        const { serverId } = request.user;
        const canCreate = await mongoService.checkServerStorageLimit(serverId, 0);
        if (!canCreate) {
            return reply.code(403).send({
                error: 'Server storage limit exceeded',
                limit: Number(config_1.config.defaultServerStorageLimit),
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
        }
        catch (error) {
            console.error('Error creating storage:', error);
            return reply.code(500).send({ error: 'Failed to create storage' });
        }
    });
    fastify.get('/', async (request, reply) => {
        if (!request.user) {
            return reply.code(401).send({ error: 'Unauthorized' });
        }
        const { serverId } = request.user;
        try {
            const storageConfigs = await mongoService.listStorageConfigs(serverId);
            const storagesWithUsage = await Promise.all(storageConfigs.map(async (config) => {
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
            }));
            return reply.send(storagesWithUsage);
        }
        catch (error) {
            console.error('Error listing storages:', error);
            return reply.code(500).send({ error: 'Failed to list storages' });
        }
    });
    fastify.get('/:storageId', async (request, reply) => {
        if (!request.user) {
            return reply.code(401).send({ error: 'Unauthorized' });
        }
        const { serverId } = request.user;
        const { storageId } = request.params;
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
        }
        catch (error) {
            console.error('Error getting storage:', error);
            return reply.code(500).send({ error: 'Failed to get storage' });
        }
    });
    fastify.patch('/:storageId', {
        schema: {
            body: updateStorageSchema,
        },
    }, async (request, reply) => {
        if (!request.user) {
            return reply.code(401).send({ error: 'Unauthorized' });
        }
        const { serverId } = request.user;
        const { storageId } = request.params;
        const updates = request.body;
        try {
            const storageConfig = await mongoService.getStorageConfig(serverId, storageId);
            if (!storageConfig) {
                return reply.code(404).send({ error: 'Storage not found' });
            }
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
        }
        catch (error) {
            console.error('Error updating storage:', error);
            return reply.code(500).send({ error: 'Failed to update storage' });
        }
    });
    fastify.delete('/:storageId', async (request, reply) => {
        if (!request.user) {
            return reply.code(401).send({ error: 'Unauthorized' });
        }
        const { serverId } = request.user;
        const { storageId } = request.params;
        try {
            const storageConfig = await mongoService.getStorageConfig(serverId, storageId);
            if (!storageConfig) {
                return reply.code(404).send({ error: 'Storage not found' });
            }
            await minioService.deleteFolder(serverId, storageId, '');
            await mongoService.deleteStorageConfig(serverId, storageId);
            await mongoService.deleteStorageUsage(serverId, storageId);
            return reply.code(204).send();
        }
        catch (error) {
            console.error('Error deleting storage:', error);
            return reply.code(500).send({ error: 'Failed to delete storage' });
        }
    });
    fastify.get('/server/limits', async (request, reply) => {
        if (!request.user) {
            return reply.code(401).send({ error: 'Unauthorized' });
        }
        const { serverId } = request.user;
        try {
            const serverTotalUsage = await mongoService.getServerTotalUsage(serverId);
            const serverLimit = Number(config_1.config.defaultServerStorageLimit);
            return reply.send({
                used: serverTotalUsage,
                limit: serverLimit,
                available: serverLimit - serverTotalUsage,
                percentage: Math.round((serverTotalUsage / serverLimit) * 100),
            });
        }
        catch (error) {
            console.error('Error getting server limits:', error);
            return reply.code(500).send({ error: 'Failed to get server limits' });
        }
    });
};
exports.storageRoutes = storageRoutes;
//# sourceMappingURL=storage.js.map