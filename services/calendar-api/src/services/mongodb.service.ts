import { MongoClient, Db, ObjectId, MongoServerError } from 'mongodb';
import { config } from '../config';

// CUSTOM: 元はイベントごとの手動カラーだったが、現在はユーザーの「トレードカラー」の
// 識別子としても使う共通パレット。サーバーごとに1ユーザー1色・1色1ユーザーで排他的に割り当てる。
export const TRADE_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const;
export type TradeColor = (typeof TRADE_COLORS)[number];

export const REPEAT_OPTIONS = ['none', 'daily', 'weekly', 'monthly'] as const;
export type RepeatOption = (typeof REPEAT_OPTIONS)[number];

export const REMINDER_MINUTES_OPTIONS = [5, 15, 30, 60, 1440] as const;
export type ReminderMinutes = (typeof REMINDER_MINUTES_OPTIONS)[number];

export const EDIT_PERMISSIONS = ['anyone', 'creator_only'] as const;
export type EditPermission = (typeof EDIT_PERMISSIONS)[number];

// CUSTOM: 予定の色は保存せず、表示時に該当メンバーの「現在の」トレードカラーから動的に解決する。
// これにより、ユーザーがトレードカラーを変更すると過去〜未来の全予定の表示色が
// 自動的に新しい色になる(イベント側の更新は不要)。該当メンバーが1人ならその人の
// トレードカラー、2人以上(または0人)なら共有予定として固定のグレー表示にする。
export const GROUP_EVENT_COLOR = 'gray' as const;
export type EventDisplayColor = TradeColor | typeof GROUP_EVENT_COLOR;

export interface CalendarEvent {
  _id: ObjectId;
  serverId: string;
  title: string;
  description?: string;
  location?: string;
  startAt: Date;
  endAt: Date;
  repeat: RepeatOption;
  editPermission: EditPermission;
  // CUSTOM: 予定に該当する(関係する)メンバー。作成者は常に含まれる。
  memberIds: string[];
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export type CalendarEventWithColor = CalendarEvent & { color: EventDisplayColor };

export interface CalendarReminder {
  _id: ObjectId;
  eventId: ObjectId;
  userId: string;
  minutesBefore: ReminderMinutes;
  notified: boolean;
  createdAt: Date;
}

export interface TradeColorAssignment {
  _id: ObjectId;
  serverId: string;
  userId: string;
  color: TradeColor;
  updatedAt: Date;
}

// 作成者がトレードカラー設定を削除済み・未設定のまま予定が残っている場合のフォールバック
const DEFAULT_TRADE_COLOR: TradeColor = 'blue';

export class TradeColorTakenError extends Error {
  constructor() {
    super('Trade color already taken by another user');
  }
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

    const eventsCollection = this.db.collection<CalendarEvent>('calendar_events');
    await eventsCollection.createIndex({ serverId: 1, startAt: 1 });
    await eventsCollection.createIndex({ serverId: 1, endAt: 1 });

    const remindersCollection = this.db.collection<CalendarReminder>('calendar_reminders');
    await remindersCollection.createIndex({ eventId: 1, userId: 1 }, { unique: true });
    await remindersCollection.createIndex({ notified: 1 });

    const tradeColorsCollection = this.db.collection<TradeColorAssignment>('calendar_trade_colors');
    await tradeColorsCollection.createIndex({ serverId: 1, userId: 1 }, { unique: true });
    await tradeColorsCollection.createIndex({ serverId: 1, color: 1 }, { unique: true });
  }

  private get events() {
    if (!this.db) throw new Error('Database not connected');
    return this.db.collection<CalendarEvent>('calendar_events');
  }

  private get reminders() {
    if (!this.db) throw new Error('Database not connected');
    return this.db.collection<CalendarReminder>('calendar_reminders');
  }

  private get tradeColors() {
    if (!this.db) throw new Error('Database not connected');
    return this.db.collection<TradeColorAssignment>('calendar_trade_colors');
  }

  // ---- Trade colors ----

  async listTradeColors(serverId: string): Promise<TradeColorAssignment[]> {
    return this.tradeColors.find({ serverId }).toArray();
  }

  async getTradeColor(serverId: string, userId: string): Promise<TradeColorAssignment | null> {
    return this.tradeColors.findOne({ serverId, userId });
  }

  /**
   * CUSTOM: 自分のトレードカラーを設定/変更する。同じサーバー内で他のユーザーが
   * 既に使用している色は{serverId,color}のユニークインデックスにより拒否される
   * (E11000 -> TradeColorTakenError)。自分の以前の色は同じドキュメントの上書きにより
   * 自動的に解放される(他ユーザーが参照する別ドキュメントは存在しないため)。
   */
  async setTradeColor(serverId: string, userId: string, color: TradeColor): Promise<TradeColorAssignment> {
    try {
      const result = await this.tradeColors.findOneAndUpdate(
        { serverId, userId },
        { $set: { color, updatedAt: new Date() } },
        { upsert: true, returnDocument: 'after' }
      );
      return result!;
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000) {
        throw new TradeColorTakenError();
      }
      throw error;
    }
  }

  // ---- Events ----

  private async resolveColors(serverId: string, userIds: string[]): Promise<Map<string, TradeColor>> {
    const assignments = await this.tradeColors
      .find({ serverId, userId: { $in: userIds } })
      .toArray();
    return new Map(assignments.map((assignment) => [assignment.userId, assignment.color]));
  }

  // CUSTOM: 該当メンバーが1人ならそのメンバーのトレードカラー、0人/2人以上なら
  // 共有予定として固定のグレーにする
  private attachColor(event: CalendarEvent, colorsByUserId: Map<string, TradeColor>): CalendarEventWithColor {
    if (event.memberIds.length === 1) {
      return { ...event, color: colorsByUserId.get(event.memberIds[0]) ?? DEFAULT_TRADE_COLOR };
    }
    return { ...event, color: GROUP_EVENT_COLOR };
  }

  async createEvent(data: {
    serverId: string;
    title: string;
    description?: string;
    location?: string;
    startAt: Date;
    endAt: Date;
    repeat: RepeatOption;
    editPermission: EditPermission;
    memberIds: string[];
    createdBy: string;
  }): Promise<CalendarEventWithColor> {
    const now = new Date();
    const event: Omit<CalendarEvent, '_id'> = {
      ...data,
      createdAt: now,
      updatedAt: now,
    };

    const result = await this.events.insertOne(event as CalendarEvent);
    const created = { ...event, _id: result.insertedId };
    const colorsByUserId = await this.resolveColors(data.serverId, data.memberIds);
    return this.attachColor(created, colorsByUserId);
  }

  async listEvents(serverId: string, from: Date, to: Date): Promise<CalendarEventWithColor[]> {
    // CUSTOM: 期間と重なる予定をすべて返す (startAt <= to かつ endAt >= from)
    const found = await this.events
      .find({ serverId, startAt: { $lte: to }, endAt: { $gte: from } })
      .sort({ startAt: 1 })
      .toArray();

    const colorsByUserId = await this.resolveColors(serverId, [...new Set(found.flatMap((event) => event.memberIds))]);
    return found.map((event) => this.attachColor(event, colorsByUserId));
  }

  async getEvent(serverId: string, eventId: string): Promise<CalendarEventWithColor | null> {
    if (!ObjectId.isValid(eventId)) return null;
    const found = await this.events.findOne({ _id: new ObjectId(eventId), serverId });
    if (!found) return null;

    const colorsByUserId = await this.resolveColors(serverId, found.memberIds);
    return this.attachColor(found, colorsByUserId);
  }

  async updateEvent(
    serverId: string,
    eventId: string,
    updates: Partial<Pick<CalendarEvent, 'title' | 'description' | 'location' | 'startAt' | 'endAt' | 'repeat' | 'editPermission' | 'memberIds'>>
  ): Promise<CalendarEventWithColor | null> {
    if (!ObjectId.isValid(eventId)) return null;

    const result = await this.events.findOneAndUpdate(
      { _id: new ObjectId(eventId), serverId },
      { $set: { ...updates, updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
    if (!result) return null;

    const colorsByUserId = await this.resolveColors(serverId, result.memberIds);
    return this.attachColor(result, colorsByUserId);
  }

  async deleteEvent(serverId: string, eventId: string): Promise<boolean> {
    if (!ObjectId.isValid(eventId)) return false;

    const result = await this.events.deleteOne({ _id: new ObjectId(eventId), serverId });
    if (result.deletedCount > 0) {
      await this.reminders.deleteMany({ eventId: new ObjectId(eventId) });
    }
    return result.deletedCount > 0;
  }

  async setReminder(eventId: string, userId: string, minutesBefore: ReminderMinutes): Promise<CalendarReminder> {
    const result = await this.reminders.findOneAndUpdate(
      { eventId: new ObjectId(eventId), userId },
      {
        $set: { minutesBefore, notified: false },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true, returnDocument: 'after' }
    );

    return result!;
  }

  async deleteReminder(eventId: string, userId: string): Promise<boolean> {
    const result = await this.reminders.deleteOne({ eventId: new ObjectId(eventId), userId });
    return result.deletedCount > 0;
  }

  async getReminder(eventId: string, userId: string): Promise<CalendarReminder | null> {
    if (!ObjectId.isValid(eventId)) return null;
    return this.reminders.findOne({ eventId: new ObjectId(eventId), userId });
  }

  /**
   * CUSTOM: アプリ内通知用。ユーザーが設定したリマインダーのうち、
   * 「予定の開始時刻 - minutesBefore分」を過ぎていてまだ通知していないものを返す。
   * 返却したリマインダーはnotified:trueにして以後再通知しないようにする。
   */
  async getDueReminders(
    serverId: string,
    userId: string,
    now: Date
  ): Promise<{ reminder: CalendarReminder; event: CalendarEventWithColor }[]> {
    const candidates = await this.reminders
      .aggregate<CalendarReminder & { event: CalendarEvent }>([
        { $match: { userId, notified: false } },
        {
          $lookup: {
            from: 'calendar_events',
            localField: 'eventId',
            foreignField: '_id',
            as: 'event',
          },
        },
        { $unwind: '$event' },
        { $match: { 'event.serverId': serverId } },
      ])
      .toArray();

    const due = candidates.filter((candidate) => {
      const remindAt = new Date(candidate.event.startAt.getTime() - candidate.minutesBefore * 60_000);
      return remindAt <= now;
    });

    if (due.length > 0) {
      await this.reminders.updateMany(
        { _id: { $in: due.map((candidate) => candidate._id) } },
        { $set: { notified: true } }
      );
    }

    const colorsByUserId = await this.resolveColors(serverId, [...new Set(due.flatMap((candidate) => candidate.event.memberIds))]);
    return due.map(({ event, ...reminder }) => ({ reminder, event: this.attachColor(event, colorsByUserId) }));
  }
}
