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