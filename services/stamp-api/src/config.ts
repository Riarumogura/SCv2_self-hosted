import dotenv from 'dotenv';

dotenv.config();

export const config = {
  // MinIO Configuration
  minio: {
    endpoint: process.env.MINIO_ENDPOINT || 'minio',
    port: parseInt(process.env.MINIO_PORT || '9000'),
    accessKey: process.env.MINIO_ACCESS_KEY || 'minioautumn',
    secretKey: process.env.MINIO_SECRET_KEY || 'minioautumn',
    bucket: process.env.MINIO_BUCKET || 'revolt-stamps',
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
  // CUSTOM: mise run dev (localhost:5173) はCaddy経由のDockerスタック(local.sawarachats.chat)とは
  // 別オリジンになるため、カンマ区切りで複数オリジンを許可できるようにしている
  corsOrigin: (process.env.CORS_ORIGIN || 'http://local.sawarachats.chat')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),

  // Stamp limits
  maxStampsPerServer: parseInt(process.env.MAX_STAMPS_PER_SERVER || '60'),
  // CUSTOM: クライアント側のffmpeg.wasmで既にアニメーションWebPに変換済みの
  // ファイルしか受け取らないため、サーバー側に動画処理は不要。短いクリップを
  // 想定したサイズ上限のみ持つ
  maxStampFileSizeBytes: parseInt(process.env.MAX_STAMP_FILE_SIZE || '2097152'), // 2MB
};
