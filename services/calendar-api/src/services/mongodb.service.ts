import { MongoClient, Db, ObjectId } from 'mongodb';
import { config } from '../config';

export const EVENT_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const;
export type EventColor = (typeof EVENT_COLORS)[number];

export const REPEAT_OPTIONS = ['none', 'daily', 'weekly', 'monthly'] as const;
export type RepeatOption = (typeof REPEAT_OPTIONS)[number];

export const REMINDER_MINUTES_OPTIONS = [5, 15, 30, 60, 1440] as const;
export type ReminderMinutes = (typeof REMINDER_MINUTES_OPTIONS)[number];

export interface CalendarEvent {
  _id: ObjectId;
  serverId: string;
  title: string;
  description?: string;
  location?: string;
  startAt: Date;
  endAt: Date;
  color: EventColor;
  repeat: RepeatOption;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CalendarReminder {
  _id: ObjectId;
  eventId: ObjectId;
  userId: string;
  minutesBefore: ReminderMinutes;
  notified: boolean;
  createdAt: Date;
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
  }

  private get events() {
    if (!this.db) throw new Error('Database not connected');
    return this.db.collection<CalendarEvent>('calendar_events');
  }

  private get reminders() {
    if (!this.db) throw new Error('Database not connected');
    return this.db.collection<CalendarReminder>('calendar_reminders');
  }

  async createEvent(data: {
    serverId: string;
    title: string;
    description?: string;
    location?: string;
    startAt: Date;
    endAt: Date;
    color: EventColor;
    repeat: RepeatOption;
    createdBy: string;
  }): Promise<CalendarEvent> {
    const now = new Date();
    const event: Omit<CalendarEvent, '_id'> = {
      ...data,
      createdAt: now,
      updatedAt: now,
    };

    const result = await this.events.insertOne(event as CalendarEvent);
    return { ...event, _id: result.insertedId };
  }

  async listEvents(serverId: string, from: Date, to: Date): Promise<CalendarEvent[]> {
    // CUSTOM: 期間と重なる予定をすべて返す (startAt <= to かつ endAt >= from)
    return this.events
      .find({ serverId, startAt: { $lte: to }, endAt: { $gte: from } })
      .sort({ startAt: 1 })
      .toArray();
  }

  async getEvent(serverId: string, eventId: string): Promise<CalendarEvent | null> {
    if (!ObjectId.isValid(eventId)) return null;
    return this.events.findOne({ _id: new ObjectId(eventId), serverId });
  }

  async updateEvent(
    serverId: string,
    eventId: string,
    updates: Partial<Pick<CalendarEvent, 'title' | 'description' | 'location' | 'startAt' | 'endAt' | 'color' | 'repeat'>>
  ): Promise<CalendarEvent | null> {
    if (!ObjectId.isValid(eventId)) return null;

    const result = await this.events.findOneAndUpdate(
      { _id: new ObjectId(eventId), serverId },
      { $set: { ...updates, updatedAt: new Date() } },
      { returnDocument: 'after' }
    );

    return result;
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
  ): Promise<{ reminder: CalendarReminder; event: CalendarEvent }[]> {
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

    return due.map(({ event, ...reminder }) => ({ reminder, event }));
  }
}
