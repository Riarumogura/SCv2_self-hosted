export declare class MinioService {
    private client;
    constructor();
    ensureBucket(): Promise<void>;
    uploadFile(serverId: string, storageId: string, filePath: string, fileBuffer: Buffer, contentType: string): Promise<string>;
    downloadFile(objectName: string): Promise<Buffer>;
    deleteFile(objectName: string): Promise<void>;
    listFiles(serverId: string, storageId: string, prefix?: string): Promise<string[]>;
    getFileMetadata(objectName: string): Promise<any>;
    createFolder(serverId: string, storageId: string, folderPath: string): Promise<void>;
    deleteFolder(serverId: string, storageId: string, folderPath: string): Promise<void>;
    getStorageSize(serverId: string, storageId: string): Promise<number>;
}
//# sourceMappingURL=minio.service.d.ts.map