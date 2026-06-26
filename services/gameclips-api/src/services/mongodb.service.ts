import { MongoClient, Db, ObjectId, Filter } from 'mongodb';
import { config } from '../config';

export interface GameClipCategory {
  _id: ObjectId;
  serverId: string;
  name: string;
  createdBy: string;
  createdAt: Date;
}

export interface GameClipFile {
  autumnId: string;
  tag: string;
  filename: string;
  contentType: string;
  metadata: Record<string, unknown>;
  size: number;
}

export interface GameClip {
  _id: ObjectId;
  serverId: string;
  categoryId: string;
  description: string;
  files: GameClipFile[];
  mentionedUserIds: string[];
  allowComments: boolean;
  likedBy: string[];
  commentCount: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface GameClipComment {
  _id: ObjectId;
  gameClipId: ObjectId;
  serverId: string;
  body: string;
  createdBy: string;
  createdAt: Date;
}

export const MAX_COMMENTS_PER_CLIP = 99;

export class CommentLimitExceededError extends Error {
  constructor() {
    super(`Comment limit (${MAX_COMMENTS_PER_CLIP}) exceeded for this game clip`);
  }
}

export interface ListGameClipsQuery {
  categoryId?: string;
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

    const categoriesCollection = this.db.collection<GameClipCategory>('gameclip_categories');
    await categoriesCollection.createIndex({ serverId: 1 });

    const gameClipsCollection = this.db.collection<GameClip>('gameclips');
    await gameClipsCollection.createIndex({ serverId: 1, categoryId: 1, createdAt: -1 });
    await gameClipsCollection.createIndex({ serverId: 1, createdBy: 1 });

    const commentsCollection = this.db.collection<GameClipComment>('gameclip_comments');
    await commentsCollection.createIndex({ gameClipId: 1, createdAt: 1 });
  }

  private get categories() {
    if (!this.db) throw new Error('Database not connected');
    return this.db.collection<GameClipCategory>('gameclip_categories');
  }

  private get gameClips() {
    if (!this.db) throw new Error('Database not connected');
    return this.db.collection<GameClip>('gameclips');
  }

  private get comments() {
    if (!this.db) throw new Error('Database not connected');
    return this.db.collection<GameClipComment>('gameclip_comments');
  }

  // ---- Categories ----

  async listCategories(serverId: string): Promise<GameClipCategory[]> {
    return this.categories.find({ serverId }).sort({ createdAt: 1 }).toArray();
  }

  async createCategory(data: {
    serverId: string;
    name: string;
    createdBy: string;
  }): Promise<GameClipCategory> {
    const category: Omit<GameClipCategory, '_id'> = { ...data, createdAt: new Date() };
    const result = await this.categories.insertOne(category as GameClipCategory);
    return { ...category, _id: result.insertedId };
  }

  // ---- GameClips ----

  async createGameClip(data: {
    serverId: string;
    categoryId: string;
    description: string;
    files: GameClipFile[];
    mentionedUserIds: string[];
    allowComments: boolean;
    createdBy: string;
  }): Promise<GameClip> {
    const now = new Date();
    const gameClip: Omit<GameClip, '_id'> = {
      ...data,
      likedBy: [],
      commentCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    const result = await this.gameClips.insertOne(gameClip as GameClip);
    return { ...gameClip, _id: result.insertedId };
  }

  async listGameClips(serverId: string, query: ListGameClipsQuery): Promise<GameClip[]> {
    const filter: Filter<GameClip> = { serverId };
    if (query.categoryId) filter.categoryId = query.categoryId;
    return this.gameClips.find(filter).sort({ createdAt: -1 }).toArray();
  }

  async getGameClip(serverId: string, id: string): Promise<GameClip | null> {
    if (!ObjectId.isValid(id)) return null;
    return this.gameClips.findOne({ _id: new ObjectId(id), serverId });
  }

  async updateGameClip(
    serverId: string,
    id: string,
    updates: Partial<Pick<GameClip, 'description' | 'categoryId' | 'allowComments' | 'mentionedUserIds'>>,
  ): Promise<GameClip | null> {
    if (!ObjectId.isValid(id)) return null;
    return this.gameClips.findOneAndUpdate(
      { _id: new ObjectId(id), serverId },
      { $set: { ...updates, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
  }

  async deleteGameClip(serverId: string, id: string): Promise<GameClip | null> {
    if (!ObjectId.isValid(id)) return null;
    const gameClip = await this.gameClips.findOne({ _id: new ObjectId(id), serverId });
    if (!gameClip) return null;
    await this.gameClips.deleteOne({ _id: new ObjectId(id), serverId });
    await this.comments.deleteMany({ gameClipId: new ObjectId(id) });
    return gameClip;
  }

  // ---- Likes ----

  // CUSTOM: $addToSet/$pullで重複追加を防ぎつつアトミックにトグルする。
  // 戻り値のlikedで実際にいいねされた状態になったかをハンドラ側に伝える。
  async toggleLike(serverId: string, id: string, userId: string): Promise<{ liked: boolean; likeCount: number } | null> {
    if (!ObjectId.isValid(id)) return null;

    const existing = await this.gameClips.findOne({ _id: new ObjectId(id), serverId });
    if (!existing) return null;

    const alreadyLiked = existing.likedBy.includes(userId);
    const update = alreadyLiked
      ? { $pull: { likedBy: userId } }
      : { $addToSet: { likedBy: userId } };

    const updated = await this.gameClips.findOneAndUpdate(
      { _id: new ObjectId(id), serverId },
      update as never,
      { returnDocument: 'after' },
    );
    if (!updated) return null;

    return { liked: !alreadyLiked, likeCount: updated.likedBy.length };
  }

  // ---- Comments ----

  async listComments(gameClipId: string): Promise<GameClipComment[]> {
    if (!ObjectId.isValid(gameClipId)) return [];
    return this.comments.find({ gameClipId: new ObjectId(gameClipId) }).sort({ createdAt: 1 }).toArray();
  }

  // CUSTOM: commentCount < MAX_COMMENTS_PER_CLIP の場合のみアトミックにインクリメントする。
  // findOneAndUpdateの条件にcommentCount制約を含めることで、同時リクエストでも
  // 100件目が複数挿入される競合(race condition)を防ぐ。
  async addComment(
    gameClipId: string,
    serverId: string,
    data: { body: string; createdBy: string },
  ): Promise<GameClipComment> {
    const updated = await this.gameClips.findOneAndUpdate(
      { _id: new ObjectId(gameClipId), serverId, commentCount: { $lt: MAX_COMMENTS_PER_CLIP } },
      { $inc: { commentCount: 1 } },
      { returnDocument: 'after' },
    );
    if (!updated) {
      throw new CommentLimitExceededError();
    }

    const comment: Omit<GameClipComment, '_id'> = {
      gameClipId: new ObjectId(gameClipId),
      serverId,
      ...data,
      createdAt: new Date(),
    };
    const result = await this.comments.insertOne(comment as GameClipComment);
    return { ...comment, _id: result.insertedId };
  }
}
