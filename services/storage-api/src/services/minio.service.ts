import { Client, CopySourceOptions, CopyDestinationOptions } from 'minio';
import { config } from '../config';

export interface StorageEntry {
  name: string;
  type: 'file' | 'folder';
  size: number;
  lastModified?: Date;
}

export interface StorageSearchEntry extends StorageEntry {
  path: string;
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
   * Get a readable stream for a file, for proxying downloads without
   * buffering the whole file in memory
   */
  async getObjectStream(objectName: string) {
    return this.client.getObject(config.minio.bucket, objectName);
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
   * List files and folders directly inside a path (non-recursive),
   * for rendering one level of an explorer UI at a time.
   */
  async listFilesAndFolders(
    serverId: string,
    storageId: string,
    folderPath: string = ''
  ): Promise<StorageEntry[]> {
    const basePrefix = `server_${serverId}/storage_${storageId}/`;
    const normalizedPath = folderPath.replace(/^\/+|\/+$/g, '');
    const fullPrefix = normalizedPath ? `${basePrefix}${normalizedPath}/` : basePrefix;

    const entries: StorageEntry[] = [];
    const stream = this.client.listObjectsV2(config.minio.bucket, fullPrefix, false);

    for await (const obj of stream) {
      // CUSTOM: minio-jsはrecursive=falseの場合、フォルダ(共通プレフィックス)を
      // { prefix: 'foo/' } の形で、ファイルを { name, size, lastModified } の形で返す
      const rawKey = (obj as { prefix?: string }).prefix ?? obj.name;
      if (!rawKey) continue;

      const relative = rawKey.slice(fullPrefix.length);
      if (!relative) continue;

      if (rawKey.endsWith('/')) {
        // フォルダ自身を表す空オブジェクト(createFolderで作成したマーカー)はスキップ
        const folderName = relative.replace(/\/$/, '');
        if (!folderName) continue;
        entries.push({ name: folderName, type: 'folder', size: 0 });
      } else {
        entries.push({
          name: relative,
          type: 'file',
          size: obj.size ?? 0,
          lastModified: obj.lastModified,
        });
      }
    }

    return entries;
  }

  /**
   * Recursively search files and folders by name (case-insensitive substring match).
   * Returns flat results with their full relative path inside the storage.
   */
  async searchFiles(
    serverId: string,
    storageId: string,
    query: string
  ): Promise<StorageSearchEntry[]> {
    const basePrefix = `server_${serverId}/storage_${storageId}/`;
    const lowerQuery = query.toLowerCase();
    const results: StorageSearchEntry[] = [];

    const stream = this.client.listObjectsV2(config.minio.bucket, basePrefix, true);

    for await (const obj of stream) {
      if (!obj.name) continue;
      const relative = obj.name.slice(basePrefix.length);
      if (!relative) continue;

      const isFolder = relative.endsWith('/');
      const trimmed = isFolder ? relative.slice(0, -1) : relative;
      if (!trimmed) continue;

      const baseName = trimmed.split('/').pop() || '';
      if (!baseName.toLowerCase().includes(lowerQuery)) continue;

      results.push({
        name: baseName,
        path: trimmed,
        type: isFolder ? 'folder' : 'file',
        size: isFolder ? 0 : obj.size ?? 0,
        lastModified: isFolder ? undefined : obj.lastModified,
      });
    }

    return results;
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
   * Delete folder and all contents.
   * Returns the total size and file count that were removed, so callers can
   * decrement storage_usage accordingly (folder marker objects are excluded).
   */
  async deleteFolder(
    serverId: string,
    storageId: string,
    folderPath: string
  ): Promise<{ totalSize: number; fileCount: number }> {
    // CUSTOM: folderPathが空(ストレージ全体削除)の場合に二重スラッシュになり
    // MinIOが不正なオブジェクト名として拒否するため、空の場合は付与しない
    const basePrefix = `server_${serverId}/storage_${storageId}/`;
    const prefix = folderPath ? `${basePrefix}${folderPath}/` : basePrefix;
    const objects: string[] = [];
    let totalSize = 0;
    let fileCount = 0;

    const stream = this.client.listObjectsV2(config.minio.bucket, prefix, true);

    for await (const obj of stream) {
      if (obj.name) {
        objects.push(obj.name);
        if (!obj.name.endsWith('/')) {
          totalSize += obj.size ?? 0;
          fileCount += 1;
        }
      }
    }

    if (objects.length > 0) {
      await this.client.removeObjects(config.minio.bucket, objects);
    }

    return { totalSize, fileCount };
  }

  /**
   * Rename or move a folder (and everything inside it) by copying every
   * object under the old prefix to the new prefix, then removing the old
   * objects. MinIO/S3 has no native rename, so this is copy + delete.
   */
  async renameFolder(
    serverId: string,
    storageId: string,
    oldFolderPath: string,
    newFolderPath: string
  ): Promise<void> {
    const basePrefix = `server_${serverId}/storage_${storageId}/`;
    const oldPrefix = `${basePrefix}${oldFolderPath}/`;
    const newPrefix = `${basePrefix}${newFolderPath}/`;

    const objectNames: string[] = [];
    const stream = this.client.listObjectsV2(config.minio.bucket, oldPrefix, true);
    for await (const obj of stream) {
      if (obj.name) {
        objectNames.push(obj.name);
      }
    }

    // フォルダが空(マーカーオブジェクトのみ存在しない)場合でも、移動先に
    // フォルダマーカーを作成しておく
    if (objectNames.length === 0) {
      await this.createFolder(serverId, storageId, newFolderPath);
      return;
    }

    for (const name of objectNames) {
      const newName = `${newPrefix}${name.slice(oldPrefix.length)}`;
      await this.client.copyObject(
        new CopySourceOptions({ Bucket: config.minio.bucket, Object: name }),
        new CopyDestinationOptions({ Bucket: config.minio.bucket, Object: newName })
      );
    }

    await this.client.removeObjects(config.minio.bucket, objectNames);
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