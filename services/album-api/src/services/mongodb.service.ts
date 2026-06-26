import { MongoClient, Db, ObjectId, Filter } from 'mongodb';
import { config } from '../config';

export const VIEW_PERMISSIONS = ['anyone', 'members'] as const;
export type ViewPermission = (typeof VIEW_PERMISSIONS)[number];

export const EDIT_PERMISSIONS = ['anyone', 'creator_only', 'members'] as const;
export type EditPermission = (typeof EDIT_PERMISSIONS)[number];

export interface AlbumCategory {
  _id: ObjectId;
  serverId: string;
  name: string;
  // CUSTOM: "#rrggbb"形式。<input type="color">の値をそのまま保存する
  color: string;
  createdBy: string;
  createdAt: Date;
}

export interface Album {
  _id: ObjectId;
  serverId: string;
  // CUSTOM: "YYYY-MM-DD"。このアルバムが「どの日のアルバムか」を表す値で、
  // ドキュメント自体のcreatedAt(レコード作成タイムスタンプ)とは独立している。
  // ミニカレンダー検索・条件検索の「作成日時」はこのフィールドを指す。
  date: string;
  title: string;
  categoryIds: string[];
  viewPermission: ViewPermission;
  viewMemberIds: string[];
  editPermission: EditPermission;
  editMemberIds: string[];
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AlbumPhoto {
  _id: ObjectId;
  albumId: ObjectId;
  serverId: string;
  autumnId: string;
  tag: string;
  filename?: string;
  contentType?: string;
  metadata: Record<string, unknown>;
  size?: number;
  uploadedBy: string;
  uploadedAt: Date;
}

export interface SearchAlbumsQuery {
  title?: string;
  dateFrom?: string;
  dateTo?: string;
  categoryIds?: string[];
}

export class MongoDBService {
  private client: MongoClient;
  private db: Db | null = null;

  constructor() {
    this.client = new MongoClient(config.mongodb.uri);
  }

  async connect(): Promise<void> {
    await this.client.connect();
    this.db = this.client.db(config.mongodb.dbName);
    await this.ensureCollections();
  }

  async disconnect(): Promise<void> {
    await this.client.close();
  }

  private async ensureCollections(): Promise<void> {
    if (!this.db) return;

    const categoriesCollection = this.db.collection<AlbumCategory>('album_categories');
    await categoriesCollection.createIndex({ serverId: 1 });

    const albumsCollection = this.db.collection<Album>('albums');
    await albumsCollection.createIndex({ serverId: 1, date: 1 });
    await albumsCollection.createIndex({ serverId: 1, title: 1 });
    await albumsCollection.createIndex({ serverId: 1, categoryIds: 1 });

    const photosCollection = this.db.collection<AlbumPhoto>('album_photos');
    await photosCollection.createIndex({ albumId: 1, uploadedAt: 1 });
  }

  private get categories() {
    if (!this.db) throw new Error('Database not connected');
    return this.db.collection<AlbumCategory>('album_categories');
  }

  private get albums() {
    if (!this.db) throw new Error('Database not connected');
    return this.db.collection<Album>('albums');
  }

  private get photos() {
    if (!this.db) throw new Error('Database not connected');
    return this.db.collection<AlbumPhoto>('album_photos');
  }

  // CUSTOM: 閲覧可能なアルバムのみに絞り込むMongoフィルタ。誰でも閲覧可、
  // 作成者本人、または閲覧メンバーに指定されている場合に閲覧可能とする。
  private viewableFilter(userId: string): Filter<Album> {
    return {
      $or: [
        { viewPermission: 'anyone' },
        { createdBy: userId },
        { viewMemberIds: userId },
      ],
    };
  }

  // ---- Categories ----

  async listCategories(serverId: string): Promise<AlbumCategory[]> {
    return this.categories.find({ serverId }).sort({ createdAt: 1 }).toArray();
  }

  async createCategory(data: {
    serverId: string;
    name: string;
    color: string;
    createdBy: string;
  }): Promise<AlbumCategory> {
    const category: Omit<AlbumCategory, '_id'> = { ...data, createdAt: new Date() };
    const result = await this.categories.insertOne(category as AlbumCategory);
    return { ...category, _id: result.insertedId };
  }

  private async getCategoriesByIds(serverId: string, ids: string[]): Promise<AlbumCategory[]> {
    const objectIds = ids.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));
    if (objectIds.length === 0) return [];
    return this.categories.find({ serverId, _id: { $in: objectIds } }).toArray();
  }

  // ---- Albums ----

  async createAlbum(data: {
    serverId: string;
    date: string;
    title: string;
    categoryIds: string[];
    viewPermission: ViewPermission;
    viewMemberIds: string[];
    editPermission: EditPermission;
    editMemberIds: string[];
    createdBy: string;
  }): Promise<Album> {
    const now = new Date();
    const album: Omit<Album, '_id'> = { ...data, createdAt: now, updatedAt: now };
    const result = await this.albums.insertOne(album as Album);
    return { ...album, _id: result.insertedId };
  }

  async listAlbumsByDate(serverId: string, date: string, userId: string): Promise<Album[]> {
    return this.albums
      .find({ serverId, date, ...this.viewableFilter(userId) })
      .sort({ createdAt: 1 })
      .toArray();
  }

  // CUSTOM: ミニカレンダーの日付色付け用。指定期間内の閲覧可能なアルバムを取得し、
  // カテゴリ色を解決した上で日付ごとに重複のない色一覧へ集約する。
  async listDateColors(
    serverId: string,
    from: string,
    to: string,
    userId: string,
  ): Promise<{ date: string; colors: string[] }[]> {
    const found = await this.albums
      .find({ serverId, date: { $gte: from, $lte: to }, ...this.viewableFilter(userId) })
      .toArray();

    const allCategoryIds = [...new Set(found.flatMap((album) => album.categoryIds))];
    const categories = await this.getCategoriesByIds(serverId, allCategoryIds);
    const colorById = new Map(categories.map((category) => [category._id.toString(), category.color]));

    const colorsByDate = new Map<string, Set<string>>();
    for (const album of found) {
      const set = colorsByDate.get(album.date) ?? new Set<string>();
      for (const categoryId of album.categoryIds) {
        const color = colorById.get(categoryId);
        if (color) set.add(color);
      }
      colorsByDate.set(album.date, set);
    }

    return Array.from(colorsByDate.entries()).map(([date, colors]) => ({
      date,
      colors: Array.from(colors),
    }));
  }

  async searchAlbums(serverId: string, query: SearchAlbumsQuery, userId: string): Promise<Album[]> {
    const filter: Filter<Album> = { serverId, ...this.viewableFilter(userId) };

    if (query.title) {
      // CUSTOM: 部分一致(大文字小文字区別なし)。ユーザー入力を正規表現の特殊文字として
      // 解釈させないようエスケープする。
      const escaped = query.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.title = { $regex: escaped, $options: 'i' };
    }
    if (query.dateFrom || query.dateTo) {
      filter.date = {
        ...(query.dateFrom ? { $gte: query.dateFrom } : {}),
        ...(query.dateTo ? { $lte: query.dateTo } : {}),
      };
    }
    if (query.categoryIds && query.categoryIds.length > 0) {
      filter.categoryIds = { $in: query.categoryIds };
    }

    return this.albums.find(filter).sort({ date: -1, createdAt: -1 }).toArray();
  }

  async getAlbum(serverId: string, albumId: string): Promise<Album | null> {
    if (!ObjectId.isValid(albumId)) return null;
    return this.albums.findOne({ _id: new ObjectId(albumId), serverId });
  }

  async updateAlbum(
    serverId: string,
    albumId: string,
    updates: Partial<
      Pick<
        Album,
        'title' | 'date' | 'categoryIds' | 'viewPermission' | 'viewMemberIds' | 'editPermission' | 'editMemberIds'
      >
    >,
  ): Promise<Album | null> {
    if (!ObjectId.isValid(albumId)) return null;

    const result = await this.albums.findOneAndUpdate(
      { _id: new ObjectId(albumId), serverId },
      { $set: { ...updates, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    return result;
  }

  async deleteAlbum(serverId: string, albumId: string): Promise<boolean> {
    if (!ObjectId.isValid(albumId)) return false;

    const result = await this.albums.deleteOne({ _id: new ObjectId(albumId), serverId });
    if (result.deletedCount > 0) {
      await this.photos.deleteMany({ albumId: new ObjectId(albumId) });
    }
    return result.deletedCount > 0;
  }

  // ---- Photos ----

  async listPhotos(albumId: string): Promise<AlbumPhoto[]> {
    if (!ObjectId.isValid(albumId)) return [];
    return this.photos.find({ albumId: new ObjectId(albumId) }).sort({ uploadedAt: 1 }).toArray();
  }

  async addPhoto(data: {
    albumId: string;
    serverId: string;
    autumnId: string;
    tag: string;
    filename?: string;
    contentType?: string;
    metadata: Record<string, unknown>;
    size?: number;
    uploadedBy: string;
  }): Promise<AlbumPhoto> {
    const photo: Omit<AlbumPhoto, '_id'> = {
      ...data,
      albumId: new ObjectId(data.albumId),
      uploadedAt: new Date(),
    };
    const result = await this.photos.insertOne(photo as AlbumPhoto);
    return { ...photo, _id: result.insertedId };
  }

  async deletePhoto(albumId: string, photoId: string): Promise<boolean> {
    if (!ObjectId.isValid(albumId) || !ObjectId.isValid(photoId)) return false;
    const result = await this.photos.deleteOne({ _id: new ObjectId(photoId), albumId: new ObjectId(albumId) });
    return result.deletedCount > 0;
  }
}
