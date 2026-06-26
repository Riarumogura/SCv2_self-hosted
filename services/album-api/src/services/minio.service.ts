import { Client } from 'minio';
import { config } from '../config';

export interface AlbumFileMetadata {
  size: number;
  contentType: string;
  lastModified: Date;
}

// CUSTOM: アルバムの写真・動画はAutumn(チャット添付の共有ファイルサーバー)を使わず、
// 専用のMinIOバケットに直接保存する。Autumnはused_for(実際にメッセージ等として
// 使われたか)が設定されていないアップロードの取得を404で拒否する仕様があり、
// アルバムはメッセージを送信しないためこの条件を満たせず、取得が常に失敗していた
// (storage-api/stamp-apiと同じMinIO直接配信方式に倣う)
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

  async ensureBucket(): Promise<void> {
    const bucketExists = await this.client.bucketExists(config.minio.bucket);
    if (!bucketExists) {
      await this.client.makeBucket(config.minio.bucket, 'us-east-1');
    }
  }

  async uploadFile(objectName: string, fileBuffer: Buffer, contentType: string): Promise<void> {
    await this.client.putObject(
      config.minio.bucket,
      objectName,
      fileBuffer,
      fileBuffer.length,
      { 'Content-Type': contentType },
    );
  }

  async getObjectStream(objectName: string) {
    return this.client.getObject(config.minio.bucket, objectName);
  }

  async getFileMetadata(objectName: string): Promise<AlbumFileMetadata> {
    const stat = await this.client.statObject(config.minio.bucket, objectName);
    return {
      size: stat.size,
      contentType: stat.metaData?.['content-type'] || 'application/octet-stream',
      lastModified: stat.lastModified,
    };
  }

  async deleteFile(objectName: string): Promise<void> {
    await this.client.removeObject(config.minio.bucket, objectName);
  }
}
