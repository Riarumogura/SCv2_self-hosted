"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MinioService = void 0;
const minio_1 = require("minio");
const config_1 = require("../config");
class MinioService {
    client;
    constructor() {
        this.client = new minio_1.Client({
            endPoint: config_1.config.minio.endpoint,
            port: config_1.config.minio.port,
            useSSL: config_1.config.minio.useSSL,
            accessKey: config_1.config.minio.accessKey,
            secretKey: config_1.config.minio.secretKey,
        });
    }
    async ensureBucket() {
        const bucketExists = await this.client.bucketExists(config_1.config.minio.bucket);
        if (!bucketExists) {
            await this.client.makeBucket(config_1.config.minio.bucket, 'us-east-1');
        }
    }
    async uploadFile(serverId, storageId, filePath, fileBuffer, contentType) {
        const objectName = `server_${serverId}/storage_${storageId}/${filePath}`;
        await this.client.putObject(config_1.config.minio.bucket, objectName, fileBuffer, fileBuffer.length, { 'Content-Type': contentType });
        return objectName;
    }
    async downloadFile(objectName) {
        const stream = await this.client.getObject(config_1.config.minio.bucket, objectName);
        const chunks = [];
        for await (const chunk of stream) {
            chunks.push(chunk);
        }
        return Buffer.concat(chunks);
    }
    async deleteFile(objectName) {
        await this.client.removeObject(config_1.config.minio.bucket, objectName);
    }
    async listFiles(serverId, storageId, prefix = '') {
        const fullPrefix = `server_${serverId}/storage_${storageId}/${prefix}`;
        const objects = [];
        const stream = this.client.listObjectsV2(config_1.config.minio.bucket, fullPrefix, true);
        for await (const obj of stream) {
            if (obj.name) {
                const relativePath = obj.name.replace(fullPrefix, '');
                if (relativePath) {
                    objects.push(relativePath);
                }
            }
        }
        return objects;
    }
    async getFileMetadata(objectName) {
        const stat = await this.client.statObject(config_1.config.minio.bucket, objectName);
        return {
            size: stat.size,
            contentType: stat.metaData?.['content-type'] || 'application/octet-stream',
            lastModified: stat.lastModified,
            etag: stat.etag,
        };
    }
    async createFolder(serverId, storageId, folderPath) {
        const objectName = `server_${serverId}/storage_${storageId}/${folderPath}/`;
        await this.client.putObject(config_1.config.minio.bucket, objectName, Buffer.from(''), 0);
    }
    async deleteFolder(serverId, storageId, folderPath) {
        const prefix = `server_${serverId}/storage_${storageId}/${folderPath}/`;
        const objects = [];
        const stream = this.client.listObjectsV2(config_1.config.minio.bucket, prefix, true);
        for await (const obj of stream) {
            if (obj.name) {
                objects.push(obj.name);
            }
        }
        if (objects.length > 0) {
            await this.client.removeObjects(config_1.config.minio.bucket, objects);
        }
    }
    async getStorageSize(serverId, storageId) {
        const prefix = `server_${serverId}/storage_${storageId}/`;
        let totalSize = 0;
        const stream = this.client.listObjectsV2(config_1.config.minio.bucket, prefix, true);
        for await (const obj of stream) {
            if (obj.size) {
                totalSize += obj.size;
            }
        }
        return totalSize;
    }
}
exports.MinioService = MinioService;
//# sourceMappingURL=minio.service.js.map