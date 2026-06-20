import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  MongoDBService,
  CalendarEvent,
  EVENT_COLORS,
  REPEAT_OPTIONS,
  REMINDER_MINUTES_OPTIONS,
} from '../services/mongodb.service';

const createEventSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  location: z.string().max(200).optional(),
  startAt: z.coerce.date(),
  endAt: z.coerce.date(),
  color: z.enum(EVENT_COLORS).default('blue'),
  repeat: z.enum(REPEAT_OPTIONS).default('none'),
}).refine((data) => data.endAt >= data.startAt, {
  message: 'endAt must not be before startAt',
});

const updateEventSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  location: z.string().max(200).optional(),
  startAt: z.coerce.date().optional(),
  endAt: z.coerce.date().optional(),
  color: z.enum(EVENT_COLORS).optional(),
  repeat: z.enum(REPEAT_OPTIONS).optional(),
});

const listEventsQuerySchema = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
});

const remindSchema = z.object({
  minutesBefore: z.coerce
    .number()
    .refine((m): m is (typeof REMINDER_MINUTES_OPTIONS)[number] => REMINDER_MINUTES_OPTIONS.includes(m as never), {
      message: `minutesBefore must be one of: ${REMINDER_MINUTES_OPTIONS.join(', ')}`,
    }),
});

function serializeEvent(event: CalendarEvent) {
  const { _id, ...rest } = event;
  return { id: _id.toString(), ...rest };
}

export const calendarRoutes: FastifyPluginAsync = async (fastify) => {
  const mongoService = new MongoDBService();

  fastify.addHook('onReady', async () => {
    await mongoService.connect();
  });

  fastify.addHook('onClose', async () => {
    await mongoService.disconnect();
  });

  // List events in a date range
  fastify.get('/events', async (request, reply) => {
    if (!request.user) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const parsed = listEventsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid query parameters', details: parsed.error.issues });
    }

    const { from, to } = parsed.data;
    const { serverId } = request.user;

    try {
      const events = await mongoService.listEvents(serverId, from, to);
      return reply.send(events.map(serializeEvent));
    } catch (error) {
      console.error('Error listing events:', error);
      return reply.code(500).send({ error: 'Failed to list events' });
    }
  });

  // Create event
  fastify.post('/events', async (request, reply) => {
    if (!request.user) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const parsed = createEventSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request body', details: parsed.error.issues });
    }

    const { serverId, id: userId } = request.user;

    try {
      const event = await mongoService.createEvent({ ...parsed.data, serverId, createdBy: userId });
      return reply.code(201).send(serializeEvent(event));
    } catch (error) {
      console.error('Error creating event:', error);
      return reply.code(500).send({ error: 'Failed to create event' });
    }
  });

  // Get event details
  fastify.get('/events/:id', async (request, reply) => {
    if (!request.user) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const { id } = request.params as { id: string };
    const { serverId } = request.user;

    try {
      const event = await mongoService.getEvent(serverId, id);
      if (!event) {
        return reply.code(404).send({ error: 'Event not found' });
      }
      return reply.send(serializeEvent(event));
    } catch (error) {
      console.error('Error getting event:', error);
      return reply.code(500).send({ error: 'Failed to get event' });
    }
  });

  // Update event
  fastify.put('/events/:id', async (request, reply) => {
    if (!request.user) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const { id } = request.params as { id: string };
    const { serverId } = request.user;

    const parsed = updateEventSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request body', details: parsed.error.issues });
    }

    try {
      const existing = await mongoService.getEvent(serverId, id);
      if (!existing) {
        return reply.code(404).send({ error: 'Event not found' });
      }

      const startAt = parsed.data.startAt ?? existing.startAt;
      const endAt = parsed.data.endAt ?? existing.endAt;
      if (endAt < startAt) {
        return reply.code(400).send({ error: 'endAt must not be before startAt' });
      }

      const updated = await mongoService.updateEvent(serverId, id, parsed.data);
      if (!updated) {
        return reply.code(500).send({ error: 'Failed to update event' });
      }
      return reply.send(serializeEvent(updated));
    } catch (error) {
      console.error('Error updating event:', error);
      return reply.code(500).send({ error: 'Failed to update event' });
    }
  });

  // Delete event
  fastify.delete('/events/:id', async (request, reply) => {
    if (!request.user) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const { id } = request.params as { id: string };
    const { serverId } = request.user;

    try {
      const deleted = await mongoService.deleteEvent(serverId, id);
      if (!deleted) {
        return reply.code(404).send({ error: 'Event not found' });
      }
      return reply.code(204).send();
    } catch (error) {
      console.error('Error deleting event:', error);
      return reply.code(500).send({ error: 'Failed to delete event' });
    }
  });

  // Set reminder for an event (per-user)
  fastify.post('/events/:id/remind', async (request, reply) => {
    if (!request.user) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const { id } = request.params as { id: string };
    const { serverId, id: userId } = request.user;

    const parsed = remindSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request body', details: parsed.error.issues });
    }

    try {
      const event = await mongoService.getEvent(serverId, id);
      if (!event) {
        return reply.code(404).send({ error: 'Event not found' });
      }

      const reminder = await mongoService.setReminder(id, userId, parsed.data.minutesBefore);
      return reply.code(201).send({
        eventId: reminder.eventId.toString(),
        userId: reminder.userId,
        minutesBefore: reminder.minutesBefore,
      });
    } catch (error) {
      console.error('Error setting reminder:', error);
      return reply.code(500).send({ error: 'Failed to set reminder' });
    }
  });

  // Remove reminder for an event (per-user)
  fastify.delete('/events/:id/remind', async (request, reply) => {
    if (!request.user) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const { id } = request.params as { id: string };
    const { id: userId } = request.user;

    try {
      const deleted = await mongoService.deleteReminder(id, userId);
      if (!deleted) {
        return reply.code(404).send({ error: 'Reminder not found' });
      }
      return reply.code(204).send();
    } catch (error) {
      console.error('Error deleting reminder:', error);
      return reply.code(500).send({ error: 'Failed to delete reminder' });
    }
  });

  // Get current user's reminder setting for an event (used to prefill the edit form)
  fastify.get('/events/:id/remind', async (request, reply) => {
    if (!request.user) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const { id } = request.params as { id: string };
    const { id: userId } = request.user;

    try {
      const reminder = await mongoService.getReminder(id, userId);
      if (!reminder) {
        return reply.code(404).send({ error: 'Reminder not found' });
      }
      return reply.send({ minutesBefore: reminder.minutesBefore });
    } catch (error) {
      console.error('Error getting reminder:', error);
      return reply.code(500).send({ error: 'Failed to get reminder' });
    }
  });

  // CUSTOM: アプリ内通知用ポーリングエンドポイント。Web Pushは未対応(別タスク)のため、
  // フロントエンドがカレンダーパネル表示中に定期ポーリングしてスナックバー通知を出す。
  fastify.get('/reminders/due', async (request, reply) => {
    if (!request.user) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const { serverId, id: userId } = request.user;

    try {
      const due = await mongoService.getDueReminders(serverId, userId, new Date());
      return reply.send(
        due.map(({ reminder, event }) => ({
          minutesBefore: reminder.minutesBefore,
          event: serializeEvent(event),
        })),
      );
    } catch (error) {
      console.error('Error getting due reminders:', error);
      return reply.code(500).send({ error: 'Failed to get due reminders' });
    }
  });
};
