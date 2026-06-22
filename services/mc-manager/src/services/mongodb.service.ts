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
  // CUSTOM: zipアップロード時、起動jarの候補が複数見つかり一意に決められない状態。
  // ユーザーが/select-jarで確定するまでstart不可。
  'PENDING_JAR_SELECTION',
] as const;
export type McServerStatus = (typeof MC_SERVER_STATUSES)[number];

export const MC_SERVER_SOURCES = ['NEW', 'UPLOAD'] as const;
export type McServerSource = (typeof MC_SERVER_SOURCES)[number];

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
  // CUSTOM: NEW=itzgイメージに自動ダウンロードさせる(従来通り)。
  // UPLOAD=zipでアップロードされた既存サーバーファイルをそのまま起動する。
  source: McServerSource;
  // UPLOAD時、/dataからの相対パスで起動するjarを指す。候補確定前はnull。
  customJarPath: string | null;
  // UPLOAD時、起動jar候補が複数見つかった場合の一覧(/dataからの相対パス)。
  // 候補確定後はnullに戻す。
  pendingJarCandidates: string[] | null;
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
      source: 'NEW',
      customJarPath: null,
      pendingJarCandidates: null,
      createdAt: now,
      updatedAt: now,
    };

    const result = await this.servers.insertOne(server as McServer);
    return { ...server, _id: result.insertedId };
  }

  // CUSTOM: zipアップロード経由の作成。jarCandidatesが1件ならcustomJarPathを確定して
  // status:'CREATED'、0件は呼び出し側(route)でエラーにする想定でこのメソッドには来ない、
  // 2件以上ならstatus:'PENDING_JAR_SELECTION'でpendingJarCandidatesに候補一覧を残す。
  async createUploadedServer(data: {
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
    jarCandidates: string[];
  }): Promise<McServer> {
    const now = new Date();
    const { jarCandidates, ...rest } = data;
    const resolved = jarCandidates.length === 1;
    const server: Omit<McServer, '_id'> = {
      ...rest,
      containerId: null,
      status: resolved ? 'CREATED' : 'PENDING_JAR_SELECTION',
      source: 'UPLOAD',
      customJarPath: resolved ? jarCandidates[0] : null,
      pendingJarCandidates: resolved ? null : jarCandidates,
      createdAt: now,
      updatedAt: now,
    };

    const result = await this.servers.insertOne(server as McServer);
    return { ...server, _id: result.insertedId };
  }

  // CUSTOM: PENDING_JAR_SELECTION状態のサーバーについて、jarPathが
  // pendingJarCandidatesに含まれることを確認したうえでcustomJarPathを確定する
  // (実ファイル存在チェックは呼び出し側のroute/サービス層で行う)。
  async finalizeJarSelection(serverId: string, mcId: string, jarPath: string): Promise<McServer | null> {
    return this.servers.findOneAndUpdate(
      { serverId, mcId, pendingJarCandidates: jarPath },
      {
        $set: {
          customJarPath: jarPath,
          pendingJarCandidates: null,
          status: 'CREATED',
          updatedAt: new Date(),
        },
      },
      { returnDocument: 'after' },
    );
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
