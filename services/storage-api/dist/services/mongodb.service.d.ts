export interface StorageConfig {
    _id: string;
    serverId: string;
    name: string;
    storageId: string;
    sizeLimit: number;
    createdAt: Date;
    updatedAt: Date;
}
export interface StorageUsage {
    _id: string;
    serverId: string;
    storageId: string;
    totalSize: number;
    fileCount: number;
    lastUpdated: Date;
}
export declare class MongoDBService {
    private client;
    private db;
    constructor();
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    private ensureCollections;
    createStorageConfig(serverId: string, name: string, sizeLimit: number): Promise<StorageConfig>;
    getStorageConfig(serverId: string, storageId: string): Promise<StorageConfig | null>;
    listStorageConfigs(serverId: string): Promise<StorageConfig[]>;
    updateStorageConfig(serverId: string, storageId: string, updates: Partial<Omit<StorageConfig, '_id' | 'serverId' | 'storageId' | 'createdAt'>>): Promise<StorageConfig | null>;
    deleteStorageConfig(serverId: string, storageId: string): Promise<boolean>;
    updateStorageUsage(serverId: string, storageId: string, sizeDelta: number, fileCountDelta: number): Promise<StorageUsage>;
    getStorageUsage(serverId: string, storageId: string): Promise<StorageUsage | null>;
    getServerTotalUsage(serverId: string): Promise<number>;
    deleteStorageUsage(serverId: string, storageId: string): Promise<boolean>;
    private generateStorageId;
    checkStorageLimit(serverId: string, storageId: string, additionalSize: number): Promise<boolean>;
    checkServerStorageLimit(serverId: string, additionalSize: number): Promise<boolean>;
}
//# sourceMappingURL=mongodb.service.d.ts.map