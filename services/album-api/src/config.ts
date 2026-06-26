import dotenv from 'dotenv';

dotenv.config();

export const config = {
  // MongoDB Configuration
  mongodb: {
    uri: process.env.MONGODB_URI || 'mongodb://database:27017',
    dbName: process.env.MONGODB_DB_NAME || 'sawarachats',
  },

  // MinIO Configuration
  // CUSTOM: Autumn(チャット添付の共有ファイルサーバー)はused_for(実際にメッセージ等に
  // 使われたか)が無いアップロードの取得を404で拒否する仕様のため、アルバムの写真・動画は
  // Autumnを使わず専用バケットに直接保存する(storage-api/stamp-apiと同じ方式)
  minio: {
    endpoint: process.env.MINIO_ENDPOINT || 'minio',
    port: parseInt(process.env.MINIO_PORT || '9000'),
    accessKey: process.env.MINIO_ACCESS_KEY || 'minioautumn',
    secretKey: process.env.MINIO_SECRET_KEY || 'minioautumn',
    bucket: process.env.MINIO_BUCKET || 'revolt-albums',
    useSSL: process.env.MINIO_USE_SSL === 'true',
  },

  // API Configuration
  apiPort: parseInt(process.env.API_PORT || '3000'),
  apiHost: process.env.API_HOST || '0.0.0.0',
  nodeEnv: process.env.NODE_ENV || 'development',

  // Stoat API for authentication
  stoatApiUrl: process.env.STOAT_API_URL || 'http://api:14702',

  // CORS
  corsOrigin: (process.env.CORS_ORIGIN || 'http://local.sawarachats.chat').split(','),

  // 写真・動画アップロードの最大サイズ(バイト)。動画を想定し100MBをデフォルトにする
  maxFileSizeBytes: parseInt(process.env.MAX_ALBUM_FILE_SIZE || '104857600'),
};
