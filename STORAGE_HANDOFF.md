# SawaraChats オンラインストレージ機能 引き継ぎドキュメント

## 1. フェーズ1で実装した内容

### 作成・変更したファイルの絶対パス一覧
1. `/Users/wakisakahayato/GitHub/SawaraChats_v2/SCv2_self-hosted/services/storage-api/package.json`
2. `/Users/wakisakahayato/GitHub/SawaraChats_v2/SCv2_self-hosted/services/storage-api/tsconfig.json`
3. `/Users/wakisakahayato/GitHub/SawaraChats_v2/SCv2_self-hosted/services/storage-api/Dockerfile`
4. `/Users/wakisakahayato/GitHub/SawaraChats_v2/SCv2_self-hosted/services/storage-api/.env.example`
5. `/Users/wakisakahayato/GitHub/SawaraChats_v2/SCv2_self-hosted/services/storage-api/src/config.ts`
6. `/Users/wakisakahayato/GitHub/SawaraChats_v2/SCv2_self-hosted/services/storage-api/src/index.ts`
7. `/Users/wakisakahayato/GitHub/SawaraChats_v2/SCv2_self-hosted/services/storage-api/src/plugins/auth.ts`
8. `/Users/wakisakahayato/GitHub/SawaraChats_v2/SCv2_self-hosted/services/storage-api/src/services/minio.service.ts`
9. `/Users/wakisakahayato/GitHub/SawaraChats_v2/SCv2_self-hosted/services/storage-api/src/services/mongodb.service.ts`
10. `/Users/wakisakahayato/GitHub/SawaraChats_v2/SCv2_self-hosted/services/storage-api/src/routes/storage.ts`
11. `/Users/wakisakahayato/GitHub/SawaraChats_v2/SCv2_self-hosted/compose.yml`

### 各ファイルの役割
- **package.json**: Node.jsプロジェクトの依存関係とスクリプト定義
- **tsconfig.json**: TypeScriptコンパイラ設定
- **Dockerfile**: Dockerイメージビルド設定
- **.env.example**: 環境変数設定例
- **src/config.ts**: アプリケーション設定管理
- **src/index.ts**: Fastifyサーバー起動とプラグイン登録
- **src/plugins/auth.ts**: Stoat APIとのトークン認証プラグイン
- **src/services/minio.service.ts**: MinIO S3 SDKを使用したファイル操作サービス
- **src/services/mongodb.service.ts**: MongoDBを使用したストレージ設定・使用量管理サービス
- **src/routes/storage.ts**: ストレージCRUD操作APIルート
- **compose.yml**: Docker Compose設定（storage-apiサービス追加）

### 重要な設計判断とその理由
1. **2バケット戦略**: `revolt-uploads`（既存チャット用）と `revolt-storage`（新規ストレージ用）を分離。既存機能への影響を最小限に抑えるため。
2. **フォルダ構造**: `server_{serverID}/storage_{storageID}/` の階層構造。サーバー単位・ストレージ単位での分離を実現。
3. **認証方式**: Authorization: BearerトークンでStoat APIと連携。既存認証システムを再利用し、セキュリティを確保。
4. **容量管理**: MongoDBに `storage_configs` と `storage_usage` コレクションを追加。リアルタイムな容量チェックを可能に。

## 2. 確定した設計方針

### MinIOバケット戦略
- **revolt-uploads**: チャット専用（Stoat既存・変更しない）
- **revolt-storage**: オンラインストレージ専用（新規作成）

### フォルダ構造
```
revolt-storage/
└── server_{serverID}/
    └── storage_{storageID}/
        └── (ファイル・フォルダ)
```

### 認証方式
- フロントエンドからstorage-apiへのリクエストに `Authorization: Bearer {stoatのセッショントークン}` を付与
- storage-apiがStoatのAPIにトークン検証リクエストを送って認証
- Stoatの既存認証コードは変更しない

### 容量管理DB設計
- **storage_configs**: ストレージ定義（名前・上限・サーバーID）
- **storage_usage**: 使用量キャッシュ

## 3. 実装済みファイルの内容を全文記載

### services/storage-api/package.json
```json
{
  "name": "storage-api",
  "version": "1.0.0",
  "description": "SawaraChats Online Storage API",
  "main": "dist/index.js",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "lint": "eslint src --ext .ts",
    "test": "jest"
  },
  "dependencies": {
    "@fastify/cors": "^9.0.1",
    "@fastify/helmet": "^11.0.0",
    "@fastify/rate-limit": "^9.0.0",
    "@fastify/swagger": "^9.0.0",
    "@fastify/swagger-ui": "^5.0.0",
    "fastify": "^5.0.0",
    "mongodb": "^6.0.0",
    "zod": "^3.22.0",
    "minio": "^8.0.0",
    "dotenv": "^16.0.0",
    "axios": "^1.6.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "@types/minio": "^7.0.0",
    "@types/mongodb": "^4.0.0",
    "typescript": "^5.0.0",
    "tsx": "^4.0.0",
    "eslint": "^8.0.0",
    "@typescript-eslint/eslint-plugin": "^6.0.0",
    "@typescript-eslint/parser": "^6.0.0",
    "jest": "^29.0.0",
    "@types/jest": "^29.0.0",
    "ts-jest": "^29.0.0"
  },
  "engines": {
    "node": ">=18.0.0"
  }
}
```

### services/storage-api/tsconfig.json
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "removeComments": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "moduleResolution": "node",
    "allowSyntheticDefaultImports": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "**/*.test.ts"]
}
```

### services/storage-api/Dockerfile
```dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

RUN npm run build

EXPOSE 3000

CMD ["npm", "start"]
```

### services/storage-api/.env.example
```env
# MinIO Configuration
MINIO_ENDPOINT=minio
MINIO_PORT=9000
MINIO_ACCESS_KEY=minioautumn
MINIO_SECRET_KEY=minioautumn
MINIO_BUCKET=revolt-storage
MINIO_USE_SSL=false

# MongoDB Configuration
MONGODB_URI=mongodb://database:27017
MONGODB_DB_NAME=sawarachats

# API Configuration
API_PORT=3000
API_HOST=0.0.0.0
NODE_ENV=production

# Stoat API for authentication
STOAT_API_URL=http://api:3000

# CORS
CORS_ORIGIN=http://local.sawarachats.chat

# Storage Limits (in bytes)
DEFAULT_SERVER_STORAGE_LIMIT=274877906944  # 256GB
```

### services/storage-api/src/config.ts
```typescript
import dotenv from 'dotenv';

dotenv.config();

export const config = {
  // MinIO Configuration
  minio: {
    endpoint: process.env.MINIO_ENDPOINT || 'minio',
    port: parseInt(process.env.MINIO_PORT || '9000'),
    accessKey: process.env.MINIO_ACCESS_KEY || 'minioautumn',
    secretKey: process.env.MINIO_SECRET_KEY || 'minioautumn',
    bucket: process.env.MINIO_BUCKET || 'revolt-storage',
    useSSL: process.env.MINIO_USE_SSL === 'true',
  },

  // MongoDB Configuration
  mongodb: {
    uri: process.env.MONGODB_URI || 'mongodb://database:27017',
    dbName: process.env.MONGODB_DB_NAME || 'sawarachats',
  },

  // API Configuration
  apiPort: parseInt(process.env.API_PORT || '3000'),
  apiHost: process.env.API_HOST || '0.0.0.0',
  nodeEnv: process.env.NODE_ENV || 'development',

  // Stoat API for authentication
  stoatApiUrl: process.env.STOAT_API_URL || 'http://api:3000',

  // CORS
  corsOrigin: process.env.CORS_ORIGIN || 'http://local.sawarachats.chat',

  // Storage Limits (in bytes)
  defaultServerStorageLimit: BigInt(process.env.DEFAULT_SERVER_STORAGE_LIMIT || '274877906944'), // 256GB
};
```

### services/storage-api/src/index.ts
```typescript
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { config } from './config';
import { authPlugin } from './plugins/auth';
import { storageRoutes } from './routes/storage';

const fastify = Fastify({
  logger: true,
});

// Register plugins
fastify.register(cors, {
  origin: config.corsOrigin,
  credentials: true,
});

fastify.register(helmet);
fastify.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute',
});

fastify.register(swagger, {
  swagger: {
    info: {
      title: 'SawaraChats Storage API',
      description: 'Online storage API for SawaraChats',
      version: '1.0.0',
    },
    host: config.apiHost,
    schemes: ['http'],
    consumes: ['application/json'],
    produces: ['application/json'],
  },
});

fastify.register(swaggerUi, {
  routePrefix: '/docs',
});

// Register authentication plugin
fastify.register(authPlugin);

// Register routes
fastify.register(storageRoutes, { prefix: '/api/v1/storage' });

// Health check endpoint
fastify.get('/health', async () => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

const start = async () => {
  try {
    await fastify.listen({
      port: config.apiPort,
      host: config.apiHost,
    });
    console.log(`Storage API server listening on ${config.apiHost}:${config.apiPort}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
```

### services/storage-api/src/plugins/auth.ts
```typescript
import { FastifyPluginAsync } from 'fastify';
import axios from 'axios';
import { config } from '../config';

export interface AuthenticatedUser {
  id: string;
  username: string;
  serverId: string;
  permissions: string[];
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthenticatedUser | null;
  }
}

export const authPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.decorateRequest('user', null);

  fastify.addHook('onRequest', async (request, reply) => {
    const authHeader = request.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Authorization header missing or invalid' });
    }

    const token = authHeader.substring(7);

    try {
      // Verify token with Stoat API
      const response = await axios.get(`${config.stoatApiUrl}/users/@me`, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      // Extract server ID from request context
      const serverId = request.headers['x-server-id'] as string;
      if (!serverId) {
        return reply.code(400).send({ error: 'Server ID header missing' });
      }

      // Check if user is member of the server
      const serverResponse = await axios.get(`${config.stoatApiUrl}/servers/${serverId}/members/${response.data._id}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      if (!serverResponse.data) {
        return reply.code(403).send({ error: 'User is not a member of this server' });
      }

      // Set user object on request
      request.user = {
        id: response.data._id,
        username: response.data.username,
        serverId,
        permissions: serverResponse.data.permissions || [],
      };

    } catch (error) {
      console.error('Authentication error:', error);
      return reply.code(401).send({ error: 'Invalid or expired token' });
    }
  });
};
```

### services/storage-api/src/services/minio.service.ts
```typescript
import { Client } from 'minio';
import { config } from '../config';

export class MinioService {
  private client: Client;

  constructor() {
    this.client = new Client({
      endPoint: config.minio.endpoint,
      port: config.minio.port,
      useSSL: config.minio.useSSL,
      accessKey: config.minio.accessKey,
      secretKey: config.minio.secretKey,
    });
  }

  /**
   * Ensure bucket exists
   */
  async ensureBucket(): Promise<void> {
    const bucketExists = await this.client.bucketExists(config.minio.bucket);
    if (!bucketExists) {
      await this.client.makeBucket(config.minio.bucket, 'us-east-1');
    }
  }

  /**
   * Upload file to storage
   */
  async uploadFile(
    serverId: string,
    storageId: string,
    filePath: string,
    fileBuffer: Buffer,
    contentType: string
  ): Promise<string> {
    const objectName = `server_${serverId}/storage_${storageId}/${filePath}`;
    
    await this.client.putObject(
      config.minio.bucket,
      objectName,
      fileBuffer,
      fileBuffer.length,
      { 'Content-Type': contentType }
    );

    return objectName;
  }

  /**
   * Download file from storage
   */
  async downloadFile(objectName: string): Promise<Buffer> {
    const stream = await this.client.getObject(config.minio.bucket, objectName);
    
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    
    return Buffer.concat(chunks);
  }

  /**
   * Delete file from storage
   */
  async deleteFile(objectName: string): Promise<void> {
    await this.client.removeObject(config.minio.bucket, objectName);
  }

  /**
   * List files in a folder
   */
  async listFiles(serverId: string, storageId: string, prefix: string = ''): Promise<string[]> {
    const fullPrefix = `server_${serverId}/storage_${storageId}/${prefix}`;
    const objects: string[] = [];
    
    const stream = this.client.listObjectsV2(config.minio.bucket, fullPrefix, true);
    
    for await (const obj of stream) {
      if (obj.name) {
        // Remove the prefix to get relative path
        const relativePath = obj.name.replace(fullPrefix, '');
        if (relativePath) {
          objects.push(relativePath);
        }
      }
    }
    
    return objects;
  }

  /**
   * Get file metadata
   */
  async getFileMetadata(objectName: string): Promise<any> {
    const stat = await this.client.statObject(config.minio.bucket, objectName);
    return {
      size: stat.size,
      contentType: stat.metaData?.['content-type'] || 'application/octet-stream',
      lastModified: stat.lastModified,
      etag: stat.etag,
    };
  }

  /**
   * Create folder (empty object with trailing slash)
   */
  async createFolder(serverId: string, storageId: string, folderPath: string): Promise<void> {
    const objectName = `server_${serverId}/storage_${storageId}/${folderPath}/`;
    await this.client.putObject(config.minio.bucket, objectName, Buffer.from(''), 0);
  }

  /**
   * Delete folder and all contents
   */
  async deleteFolder(serverId: string, storageId: string, folderPath: string): Promise<void> {
    const prefix = `server_${serverId}/storage_${storageId}/${folderPath}/`;
    const objects: string[] = [];
    
    const stream = this.client.listObjectsV2(config.minio.bucket, prefix, true);
    
    for await (const obj of stream) {
      if (obj.name) {
        objects.push(obj.name);
      }
    }
    
    if (objects.length > 0) {
      await this.client.removeObjects(config.minio.bucket, objects);
    }
  }

  /**
   * Get total size of storage
   */
  async getStorageSize(serverId: string, storageId: string): Promise<number> {
    const prefix = `server_${serverId}/storage_${storageId}/`;
    let totalSize = 0;
    
    const stream = this.client.listObjectsV2(config.minio.bucket, prefix, true);
    
    for await (const obj of stream) {
      if (obj.size) {
        totalSize += obj.size;
      }
    }
    
    return totalSize;
  }
}
```

### services/storage-api/src/services/mongodb.service.ts
```typescript
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
```

### services/storage-api/src/routes/storage.ts
```typescript
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
  fastify.post('/', {
    schema: {
      body: createStorageSchema,
    },
  }, async (request, reply) => {
    if (!request.user) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const { name, sizeLimit } = request.body as z.infer<typeof createStorageSchema>;
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
  fastify.patch('/:storageId', {
    schema: {
      body: updateStorageSchema,
    },
  }, async (request, reply) => {
    if (!request.user) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const { serverId } = request.user;
    const { storageId } = request.params as { storageId: string };
    const updates = request.body as z.infer<typeof updateStorageSchema>;

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
```

### compose.yml の変更箇所 (storage-apiサービス追加部分)
```yaml
  # Create buckets for minio.
  createbuckets:
    image: docker.io/minio/mc
    depends_on:
      - minio
    entrypoint: >
      /bin/sh -c "
      while ! /usr/bin/mc ready minio; do
        /usr/bin/mc alias set minio http://minio:9000 minioautumn minioautumn;
        echo 'Waiting minio...' && sleep 1;
      done;
      /usr/bin/mc mb minio/revolt-uploads;
      /usr/bin/mc mb minio/revolt-storage;
      exit 0;
      "

  # Storage API
  storage-api:
    build: ./services/storage-api
    restart: always
    depends_on:
      database:
        condition: service_healthy
      minio:
        condition: service_started
    environment:
      MINIO_ENDPOINT: minio
      MINIO_PORT: 9000
      MINIO_ACCESS_KEY: minioautumn
      MINIO_SECRET_KEY: minioautumn
      MINIO_BUCKET: revolt-storage
      MINIO_USE_SSL: "false"
      MONGODB_URI: mongodb://database:27017
      MONGODB_DB_NAME: sawarachats
      API_PORT: 3000
      API_HOST: 0.0.0.0
      STOAT_API_URL: http://api:3000
      CORS_ORIGIN: http://local.sawarachats.chat
      DEFAULT_SERVER_STORAGE_LIMIT: "274877906944"
    ports:
      - "3001:3000"
```

## 4. 次のチャットで最初に実行する作業

### タスク3: for-web サイドバー固定メニュー追加
- **対象ファイル**: `SCv2_for-web/packages/client/src/interface/navigation/channels/ServerSidebar.tsx`
- **実装方針**: チャンネル一覧最下部に `flex-shrink:0` で固定表示
- **注意事項**: サーバーにストレージが存在しない場合のエクスペリエンス設計が必要

### タスク4: for-web エクスプローラUI実装
- **対象ファイル**: `SCv2_for-web/packages/client/src/interface/channels/text/TextChannel.tsx`
- **実装方針**: `sidebarState` に `storage` 状態を追加し、Finder風UIコンポーネントを作成

### タスク5: for-web ストレージ作成画面
- **対象ファイル**: 新規モーダルコンポーネント作成
- **実装方針**: ストレージ名/サイズ上限入力フォーム、サーバー容量上限チェック

### タスク6: 右クリックメニューとフォルダ選択ダイアログ
- **対象ファイル**: `SCv2_for-web/packages/client/components/app/menus/MessageContextMenu.tsx`
- **実装方針**: 「ストレージに保存」アクション追加、フォルダ選択ダイアログ（ツリー表示）

## 5. 次のチャットで使う引き継ぎプロンプト

```
# SawaraChats オンラインストレージ機能 フェーズ2引き継ぎ

## 前チャットで完了した作業
- services/storage-api/ のNode.js + TypeScript + Fastifyバックエンド実装
- compose.ymlにサービス追加とcreatebuckets修正
- MinIOバケット戦略確立（revolt-uploads / revolt-storage 分離）
- 認証システム実装（Stoat APIトークン連携）
- 容量管理DB設計実装（MongoDBコレクション: storage_configs / storage_usage）

## 環境情報
- self-hosted Fork: /Users/wakisakahayato/GitHub/SawaraChats_v2/SCv2_self-hosted
- for-web Fork: /Users/wakisakahayato/GitHub/SawaraChats_v2/SCv2_for-web
- 開発サーバー: mise run dev → localhost:5173

## 確定済みの設計方針
- MinIOバケット戦略: revolt-uploads（チャット専用） / revolt-storage（ストレージ専用）
- フォルダ構造: server_{serverID}/storage_{storageID}/
- 認証方式: Authorization: Bearer {stoatのセッショントークン}
- 容量管理: MongoDBコレクション（storage_configs / storage_usage）
- サーバーあたり容量上限: 初期値256GB（設定で変更可能）

## 最初にやること
以下のファイルを読み込んで現在の状態を把握してから実装を開始すること。
1. /Users/wakisakahayato/GitHub/SawaraChats_v2/SCv2_for-web/packages/client/src/interface/navigation/channels/ServerSidebar.tsx
2. /Users/wakisakahayato/GitHub/SawaraChats_v2/SCv2_for-web/packages/client/src/interface/channels/text/TextChannel.tsx
3. /Users/wakisakahayato/GitHub/SawaraChats_v2/SCv2_for-web/packages/client/components/app/menus/MessageContextMenu.tsx

## 今回実装するタスク
タスク3: サイドバー固定メニュー追加
.### 詳細
- ServerSidebar.tsx にストレージメニューを追加（チャンネル一覧最下部）
- `flex-shrink: 0` でスクロールしても固定表示
- サーバーにストレージが存在しない場合のUI設計
- ストレージ作成モーダルへのリンク実装
```

## 6. 既知の問題・懸念事項
1. **TypeScriptエラー**: 一部の型定義で軽微なエラーが発生していたが、ビルドは成功
2. **npmパッケージバージョン**: 一部のパッケージでバージョン不一致があったが、互換性のあるバージョンにダウングレードして解決
3. **認証テスト未実施**: Stoat APIとの実際の認証連携テストは未実施
4. **CORS設定**: 開発環境でのCORS設定が正しく動作するか確認が必要

## mdファイル作成後の作業
1. mdファイルの内容を表示して確認させること
2. 以下のコマンドを実行すること:
   ```
   git add .
   git status (secrets関連ファイルが含まれていないことを確認)
   git commit -m "feat: オンラインストレージ フェーズ1実装 + 引き継ぎドキュメント作成"
   git push origin develop