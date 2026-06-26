import { randomBytes } from 'crypto';
import { MongoClient, Db } from 'mongodb';
import { config } from '../config';

export interface StampDoc {
  _id: string;
  serverId: string;
  creatorId: string;
  name: string;
  objectName: string;
  width: number;
  height: number;
  durationMs: number;
  fileSize: number;
  createdAt: Date;
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
    await this.ensureCollections();
  }

  async disconnect(): Promise<void> {
    await this.client.close();
  }

  private async ensureCollections(): Promise<void> {
    if (!this.db) return;

    const stampsCollection = this.db.collection<StampDoc>('stamps');
    await stampsCollection.createIndex({ serverId: 1 });
  }

  async countStamps(serverId: string): Promise<number> {
    if (!this.db) throw new Error('Database not connected');
    const collection = this.db.collection<StampDoc>('stamps');
    return await collection.countDocuments({ serverId });
  }

  async createStamp(input: {
    serverId: string;
    creatorId: string;
    name: string;
    width: number;
    height: number;
    durationMs: number;
    fileSize: number;
  }): Promise<StampDoc> {
    if (!this.db) throw new Error('Database not connected');

    const stampId = this.generateStampId();
    const stamp: StampDoc = {
      _id: stampId,
      serverId: input.serverId,
      creatorId: input.creatorId,
      name: input.name,
      // CUSTOM: /:stampId/file ルートは認証なしで配信するため、IDから
      // オブジェクトキーを推測できないよう server_${serverId} ではなく
      // stampId自身のみをキーに含める(serverIdはMongoDB側の検索だけに使う)
      objectName: `stamps/${stampId}.webp`,
      width: input.width,
      height: input.height,
      durationMs: input.durationMs,
      fileSize: input.fileSize,
      createdAt: new Date(),
    };

    const collection = this.db.collection<StampDoc>('stamps');
    await collection.insertOne(stamp);

    return stamp;
  }

  async listStamps(serverId: string): Promise<StampDoc[]> {
    if (!this.db) throw new Error('Database not connected');
    const collection = this.db.collection<StampDoc>('stamps');
    return await collection.find({ serverId }).sort({ createdAt: -1 }).toArray();
  }

  async getStamp(stampId: string): Promise<StampDoc | null> {
    if (!this.db) throw new Error('Database not connected');
    const collection = this.db.collection<StampDoc>('stamps');
    return await collection.findOne({ _id: stampId });
  }

  async deleteStamp(stampId: string): Promise<boolean> {
    if (!this.db) throw new Error('Database not connected');
    const collection = this.db.collection<StampDoc>('stamps');
    const result = await collection.deleteOne({ _id: stampId });
    return result.deletedCount > 0;
  }

  // CUSTOM: /:stampId/file ルートが認証なしのため、IDはstorage-apiの
  // generateStorageId()(8文字のbase36)より十分長い乱数にしておく
  private generateStampId(): string {
    return randomBytes(16).toString('hex');
  }
}
