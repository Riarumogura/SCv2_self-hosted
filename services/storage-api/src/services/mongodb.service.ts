import { MongoClient, Db } from 'mongodb';
import { config } from '../config';

export interface StorageConfig {
  _id: string;
  serverId: string;
  name: string;
  storageId: string;
  sizeLimit: number; // in bytes
  createdAt: Date;
  updatedAt: Date;
}

export interface StorageUsage {
  _id: string;
  serverId: string;
  storageId: string;
  totalSize: number; // in bytes
  fileCount: number;
  lastUpdated: Date;
}

export class MongoDBService {
  private client: MongoClient;
  private db: Db | null = null;

  constructor() {
    this.client = new MongoClient(config.mongodb.uri);
  }

  async connect(): Promise<void> {
    await this.client.connect();
    this.db = this.client.db(config.mongodb.dbName);
    
    // Create collections if they don't exist
    await this.ensureCollections();
  }

  async disconnect(): Promise<void> {
    await this.client.close();
  }

  private async ensureCollections(): Promise<void> {
    if (!this.db) return;

    // Create storage_configs collection
    const storageConfigsCollection = this.db.collection<StorageConfig>('storage_configs');
    await storageConfigsCollection.createIndex({ serverId: 1, storageId: 1 }, { unique: true });
    await storageConfigsCollection.createIndex({ serverId: 1 });

    // Create storage_usage collection
    const storageUsageCollection = this.db.collection<StorageUsage>('storage_usage');
    await storageUsageCollection.createIndex({ serverId: 1, storageId: 1 }, { unique: true });
    await storageUsageCollection.createIndex({ serverId: 1 });
  }

  // Storage Config methods
  async createStorageConfig(
    serverId: string,
    name: string,
    sizeLimit: number
  ): Promise<StorageConfig> {
    if (!this.db) throw new Error('Database not connected');

    const storageId = this.generateStorageId();
    const now = new Date();
    
    const storageConfig: StorageConfig = {
      _id: `${serverId}_${storageId}`,
      serverId,
      name,
      storageId,
      sizeLimit,
      createdAt: now,
      updatedAt: now,
    };

    const collection = this.db.collection<StorageConfig>('storage_configs');
    await collection.insertOne(storageConfig);

    return storageConfig;
  }

  async getStorageConfig(serverId: string, storageId: string): Promise<StorageConfig | null> {
    if (!this.db) throw new Error('Database not connected');

    const collection = this.db.collection<StorageConfig>('storage_configs');
    return await collection.findOne({ serverId, storageId });
  }

  async listStorageConfigs(serverId: string): Promise<StorageConfig[]> {
    if (!this.db) throw new Error('Database not connected');

    const collection = this.db.collection<StorageConfig>('storage_configs');
    return await collection.find({ serverId }).toArray();
  }

  async updateStorageConfig(
    serverId: string,
    storageId: string,
    updates: Partial<Omit<StorageConfig, '_id' | 'serverId' | 'storageId' | 'createdAt'>>
  ): Promise<StorageConfig | null> {
    if (!this.db) throw new Error('Database not connected');

    const collection = this.db.collection<StorageConfig>('storage_configs');
    const result = await collection.findOneAndUpdate(
      { serverId, storageId },
      { $set: { ...updates, updatedAt: new Date() } },
      { returnDocument: 'after' }
    );

    return result;
  }

  async deleteStorageConfig(serverId: string, storageId: string): Promise<boolean> {
    if (!this.db) throw new Error('Database not connected');

    const collection = this.db.collection<StorageConfig>('storage_configs');
    const result = await collection.deleteOne({ serverId, storageId });
    return result.deletedCount > 0;
  }

  // Storage Usage methods
  async updateStorageUsage(
    serverId: string,
    storageId: string,
    sizeDelta: number,
    fileCountDelta: number
  ): Promise<StorageUsage> {
    if (!this.db) throw new Error('Database not connected');

    const collection = this.db.collection<StorageUsage>('storage_usage');
    const now = new Date();
    
    const result = await collection.findOneAndUpdate(
      { serverId, storageId },
      {
        $set: { lastUpdated: now },
        $inc: { totalSize: sizeDelta, fileCount: fileCountDelta },
        $setOnInsert: {
          _id: `${serverId}_${storageId}`,
        },
      },
      {
        upsert: true,
        returnDocument: 'after',
      }
    );

    return result!;
  }

  async getStorageUsage(serverId: string, storageId: string): Promise<StorageUsage | null> {
    if (!this.db) throw new Error('Database not connected');

    const collection = this.db.collection<StorageUsage>('storage_usage');
    return await collection.findOne({ serverId, storageId });
  }

  async getServerTotalUsage(serverId: string): Promise<number> {
    if (!this.db) throw new Error('Database not connected');

    const collection = this.db.collection<StorageUsage>('storage_usage');
    const result = await collection.aggregate([
      { $match: { serverId } },
      { $group: { _id: null, totalSize: { $sum: '$totalSize' } } },
    ]).toArray();

    return result[0]?.totalSize || 0;
  }

  async deleteStorageUsage(serverId: string, storageId: string): Promise<boolean> {
    if (!this.db) throw new Error('Database not connected');

    const collection = this.db.collection<StorageUsage>('storage_usage');
    const result = await collection.deleteOne({ serverId, storageId });
    return result.deletedCount > 0;
  }

  // Helper methods
  private generateStorageId(): string {
    return Math.random().toString(36).substring(2, 10);
  }

  async checkStorageLimit(serverId: string, storageId: string, additionalSize: number): Promise<boolean> {
    const storageConfig = await this.getStorageConfig(serverId, storageId);
    if (!storageConfig) return false;

    const storageUsage = await this.getStorageUsage(serverId, storageId);
    const currentUsage = storageUsage?.totalSize || 0;

    return currentUsage + additionalSize <= storageConfig.sizeLimit;
  }

  async checkServerStorageLimit(serverId: string, additionalSize: number): Promise<boolean> {
    const serverTotalUsage = await this.getServerTotalUsage(serverId);
    return serverTotalUsage + additionalSize <= Number(config.defaultServerStorageLimit);
  }
}