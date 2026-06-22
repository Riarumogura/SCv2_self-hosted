import { MongoClient, Db, ObjectId } from 'mongodb';
import { config } from '../config';

export const MC_SERVER_TYPES = ['VANILLA', 'FORGE', 'FABRIC', 'NEOFORGE', 'PAPER'] as const;
export type McServerType = (typeof MC_SERVER_TYPES)[number];

export const MC_SERVER_STATUSES = [
  'CREATED',
  'STARTING',
  'RUNNING',
  'STOPPING',
  'STOPPED',
  'ERROR',
] as const;
export type McServerStatus = (typeof MC_SERVER_STATUSES)[number];

export interface McServer {
  _id: ObjectId;
  serverId: string;
  mcId: string;
  name: string;
  version: string;
  type: McServerType;
  memory: string;
  port: number;
  rconPort: number;
  rconPassword: string;
  containerId: string | null;
  containerName: string;
  status: McServerStatus;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

// CUSTOM: rconPasswordはAPIレスポンスに絶対含めないため、公開用の型を別途定義する
export type PublicMcServer = Omit<McServer, 'rconPassword'>;

export function toPublicMcServer(server: McServer): PublicMcServer {
  const { rconPassword, ...rest } = server;
  return rest;
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

    const collection = this.db.collection<McServer>('mc_servers');
    await collection.createIndex({ serverId: 1, mcId: 1 }, { unique: true });
    await collection.createIndex({ serverId: 1, port: 1 });
  }

  private get servers() {
    if (!this.db) throw new Error('Database not connected');
    return this.db.collection<McServer>('mc_servers');
  }

  async listServers(serverId: string): Promise<McServer[]> {
    return this.servers.find({ serverId }).sort({ createdAt: 1 }).toArray();
  }

  async getServer(serverId: string, mcId: string): Promise<McServer | null> {
    return this.servers.findOne({ serverId, mcId });
  }

  async isPortTaken(serverId: string, port: number): Promise<boolean> {
    const existing = await this.servers.findOne({ serverId, port });
    return Boolean(existing);
  }

  async createServer(data: {
    serverId: string;
    mcId: string;
    name: string;
    version: string;
    type: McServerType;
    memory: string;
    port: number;
    rconPort: number;
    rconPassword: string;
    containerName: string;
    createdBy: string;
  }): Promise<McServer> {
    const now = new Date();
    const server: Omit<McServer, '_id'> = {
      ...data,
      containerId: null,
      status: 'CREATED',
      createdAt: now,
      updatedAt: now,
    };

    const result = await this.servers.insertOne(server as McServer);
    return { ...server, _id: result.insertedId };
  }

  async updateServer(
    serverId: string,
    mcId: string,
    updates: Partial<Pick<McServer, 'containerId' | 'status'>>,
  ): Promise<McServer | null> {
    return this.servers.findOneAndUpdate(
      { serverId, mcId },
      { $set: { ...updates, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
  }

  async deleteServer(serverId: string, mcId: string): Promise<boolean> {
    const result = await this.servers.deleteOne({ serverId, mcId });
    return result.deletedCount > 0;
  }
}
