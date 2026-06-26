import { Client } from 'minio';
import { config } from '../config';

export interface StampFileMetadata {
  size: number;
  contentType: string;
  lastModified: Date;
}

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
   * Upload a stamp's WebP bytes
   */
  async uploadStamp(objectName: string, fileBuffer: Buffer, contentType: string): Promise<void> {
    await this.client.putObject(
      config.minio.bucket,
      objectName,
      fileBuffer,
      fileBuffer.length,
      { 'Content-Type': contentType }
    );
  }

  /**
   * Get a readable stream for a file, for proxying downloads without
   * buffering the whole file in memory
   */
  async getObjectStream(objectName: string) {
    return this.client.getObject(config.minio.bucket, objectName);
  }

  /**
   * Get file metadata
   */
  async getFileMetadata(objectName: string): Promise<StampFileMetadata> {
    const stat = await this.client.statObject(config.minio.bucket, objectName);
    return {
      size: stat.size,
      contentType: stat.metaData?.['content-type'] || 'application/octet-stream',
      lastModified: stat.lastModified,
    };
  }

  /**
   * Delete a stamp's file
   */
  async deleteFile(objectName: string): Promise<void> {
    await this.client.removeObject(config.minio.bucket, objectName);
  }
}
