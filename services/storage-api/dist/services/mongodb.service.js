"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MongoDBService = void 0;
const mongodb_1 = require("mongodb");
const config_1 = require("../config");
class MongoDBService {
    client;
    db = null;
    constructor() {
        this.client = new mongodb_1.MongoClient(config_1.config.mongodb.uri);
    }
    async connect() {
        await this.client.connect();
        this.db = this.client.db(config_1.config.mongodb.dbName);
        await this.ensureCollections();
    }
    async disconnect() {
        await this.client.close();
    }
    async ensureCollections() {
        if (!this.db)
            return;
        const storageConfigsCollection = this.db.collection('storage_configs');
        await storageConfigsCollection.createIndex({ serverId: 1, storageId: 1 }, { unique: true });
        await storageConfigsCollection.createIndex({ serverId: 1 });
        const storageUsageCollection = this.db.collection('storage_usage');
        await storageUsageCollection.createIndex({ serverId: 1, storageId: 1 }, { unique: true });
        await storageUsageCollection.createIndex({ serverId: 1 });
    }
    async createStorageConfig(serverId, name, sizeLimit) {
        if (!this.db)
            throw new Error('Database not connected');
        const storageId = this.generateStorageId();
        const now = new Date();
        const storageConfig = {
            _id: `${serverId}_${storageId}`,
            serverId,
            name,
            storageId,
            sizeLimit,
            createdAt: now,
            updatedAt: now,
        };
        const collection = this.db.collection('storage_configs');
        await collection.insertOne(storageConfig);
        return storageConfig;
    }
    async getStorageConfig(serverId, storageId) {
        if (!this.db)
            throw new Error('Database not connected');
        const collection = this.db.collection('storage_configs');
        return await collection.findOne({ serverId, storageId });
    }
    async listStorageConfigs(serverId) {
        if (!this.db)
            throw new Error('Database not connected');
        const collection = this.db.collection('storage_configs');
        return await collection.find({ serverId }).toArray();
    }
    async updateStorageConfig(serverId, storageId, updates) {
        if (!this.db)
            throw new Error('Database not connected');
        const collection = this.db.collection('storage_configs');
        const result = await collection.findOneAndUpdate({ serverId, storageId }, { $set: { ...updates, updatedAt: new Date() } }, { returnDocument: 'after' });
        return result;
    }
    async deleteStorageConfig(serverId, storageId) {
        if (!this.db)
            throw new Error('Database not connected');
        const collection = this.db.collection('storage_configs');
        const result = await collection.deleteOne({ serverId, storageId });
        return result.deletedCount > 0;
    }
    async updateStorageUsage(serverId, storageId, sizeDelta, fileCountDelta) {
        if (!this.db)
            throw new Error('Database not connected');
        const collection = this.db.collection('storage_usage');
        const now = new Date();
        const result = await collection.findOneAndUpdate({ serverId, storageId }, {
            $set: { lastUpdated: now },
            $inc: { totalSize: sizeDelta, fileCount: fileCountDelta },
            $setOnInsert: {
                _id: `${serverId}_${storageId}`,
            },
        }, {
            upsert: true,
            returnDocument: 'after',
        });
        return result;
    }
    async getStorageUsage(serverId, storageId) {
        if (!this.db)
            throw new Error('Database not connected');
        const collection = this.db.collection('storage_usage');
        return await collection.findOne({ serverId, storageId });
    }
    async getServerTotalUsage(serverId) {
        if (!this.db)
            throw new Error('Database not connected');
        const collection = this.db.collection('storage_usage');
        const result = await collection.aggregate([
            { $match: { serverId } },
            { $group: { _id: null, totalSize: { $sum: '$totalSize' } } },
        ]).toArray();
        return result[0]?.totalSize || 0;
    }
    async deleteStorageUsage(serverId, storageId) {
        if (!this.db)
            throw new Error('Database not connected');
        const collection = this.db.collection('storage_usage');
        const result = await collection.deleteOne({ serverId, storageId });
        return result.deletedCount > 0;
    }
    generateStorageId() {
        return Math.random().toString(36).substring(2, 10);
    }
    async checkStorageLimit(serverId, storageId, additionalSize) {
        const storageConfig = await this.getStorageConfig(serverId, storageId);
        if (!storageConfig)
            return false;
        const storageUsage = await this.getStorageUsage(serverId, storageId);
        const currentUsage = storageUsage?.totalSize || 0;
        return currentUsage + additionalSize <= storageConfig.sizeLimit;
    }
    async checkServerStorageLimit(serverId, additionalSize) {
        const serverTotalUsage = await this.getServerTotalUsage(serverId);
        return serverTotalUsage + additionalSize <= Number(config_1.config.defaultServerStorageLimit);
    }
}
exports.MongoDBService = MongoDBService;
//# sourceMappingURL=mongodb.service.js.map