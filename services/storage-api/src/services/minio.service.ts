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