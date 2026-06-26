import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { MongoDBService, GameClip, GameClipComment, CommentLimitExceededError } from '../services/mongodb.service';
import { broadcast } from '../ws/broadcast';

const ALLOWED_CONTENT_TYPES = ['image/jpeg', 'image/png', 'video/mp4', 'video/quicktime'] as const;

const fileSchema = z.object({
  autumnId: z.string().min(1),
  tag: z.string().min(1),
  filename: z.string().min(1),
  contentType: z.enum(ALLOWED_CONTENT_TYPES),
  metadata: z.record(z.unknown()),
  size: z.number().positive(),
});

const createGameClipSchema = z.object({
  categoryId: z.string().min(1),
  description: z.string().max(500).default(''),
  files: z.array(fileSchema).min(1).max(10),
  mentionedUserIds: z.array(z.string()).max(100).default([]),
  allowComments: z.boolean().default(true),
});

const updateGameClipSchema = z.object({
  description: z.string().max(500).optional(),
  categoryId: z.string().min(1).optional(),
  allowComments: z.boolean().optional(),
  mentionedUserIds: z.array(z.string()).max(100).optional(),
});

const createCategorySchema = z.object({
  name: z.string().min(1).max(100),
});

const listQuerySchema = z.object({
  categoryId: z.string().optional(),
});

const addCommentSchema = z.object({
  body: z.string().min(1).max(500),
});

function serializeGameClip(gameClip: GameClip, userId: string) {
  const { _id, likedBy, ...rest } = gameClip;
  return {
    id: _id.toString(),
    ...rest,
    likeCount: likedBy.length,
    likedByMe: likedBy.includes(userId),
  };
}

function serializeComment(comment: GameClipComment) {
  const { _id, gameClipId, ...rest } = comment;
  return { id: _id.toString(), gameClipId: gameClipId.toString(), ...rest };
}

function canEdit(gameClip: GameClip, userId: string): boolean {
  return gameClip.createdBy === userId;
}

export const gameClipsRoutes: FastifyPluginAsync = async (fastify) => {
  const mongoService = new MongoDBService();

  fastify.addHook('onReady', async () => {
    await mongoService.connect();
  });

  fastify.addHook('onClose', async () => {
    await mongoService.disconnect();
  });

  // ---- Categories ----

  fastify.get('/categories', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Unauthorized' });

    try {
      const categories = await mongoService.listCategories(request.user.serverId);
      return reply.send(categories.map(({ _id, ...rest }) => ({ id: _id.toString(), ...rest })));
    } catch (error) {
      console.error('Error listing categories:', error);
      return reply.code(500).send({ error: 'Failed to list categories' });
    }
  });

  fastify.post('/categories', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Unauthorized' });

    const parsed = createCategorySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request body', details: parsed.error.issues });
    }

    try {
      const category = await mongoService.createCategory({
        ...parsed.data,
        serverId: request.user.serverId,
        createdBy: request.user.id,
      });
      const { _id, ...rest } = category;
      return reply.code(201).send({ id: _id.toString(), ...rest });
    } catch (error) {
      console.error('Error creating category:', error);
      return reply.code(500).send({ error: 'Failed to create category' });
    }
  });

  // ---- GameClips ----

  fastify.get('/gameclips', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Unauthorized' });

    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid query parameters', details: parsed.error.issues });
    }

    try {
      const gameClips = await mongoService.listGameClips(request.user.serverId, parsed.data);
      return reply.send(gameClips.map((gc) => serializeGameClip(gc, request.user!.id)));
    } catch (error) {
      console.error('Error listing game clips:', error);
      return reply.code(500).send({ error: 'Failed to list game clips' });
    }
  });

  fastify.post('/gameclips', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Unauthorized' });

    const parsed = createGameClipSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request body', details: parsed.error.issues });
    }

    try {
      const gameClip = await mongoService.createGameClip({
        ...parsed.data,
        serverId: request.user.serverId,
        createdBy: request.user.id,
      });
      return reply.code(201).send(serializeGameClip(gameClip, request.user.id));
    } catch (error) {
      console.error('Error creating game clip:', error);
      return reply.code(500).send({ error: 'Failed to create game clip' });
    }
  });

  fastify.get('/gameclips/:id', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Unauthorized' });
    const { id } = request.params as { id: string };

    try {
      const gameClip = await mongoService.getGameClip(request.user.serverId, id);
      if (!gameClip) return reply.code(404).send({ error: 'Game clip not found' });
      return reply.send(serializeGameClip(gameClip, request.user.id));
    } catch (error) {
      console.error('Error getting game clip:', error);
      return reply.code(500).send({ error: 'Failed to get game clip' });
    }
  });

  fastify.put('/gameclips/:id', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Unauthorized' });
    const { id } = request.params as { id: string };
    const { serverId, id: userId } = request.user;

    const parsed = updateGameClipSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request body', details: parsed.error.issues });
    }

    try {
      const existing = await mongoService.getGameClip(serverId, id);
      if (!existing) return reply.code(404).send({ error: 'Game clip not found' });
      if (!canEdit(existing, userId)) {
        return reply.code(403).send({ error: 'この投稿を編集する権限がありません' });
      }

      const updated = await mongoService.updateGameClip(serverId, id, parsed.data);
      if (!updated) return reply.code(500).send({ error: 'Failed to update game clip' });
      return reply.send(serializeGameClip(updated, userId));
    } catch (error) {
      console.error('Error updating game clip:', error);
      return reply.code(500).send({ error: 'Failed to update game clip' });
    }
  });

  fastify.delete('/gameclips/:id', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Unauthorized' });
    const { id } = request.params as { id: string };
    const { serverId, id: userId } = request.user;

    try {
      const existing = await mongoService.getGameClip(serverId, id);
      if (!existing) return reply.code(404).send({ error: 'Game clip not found' });
      if (!canEdit(existing, userId)) {
        return reply.code(403).send({ error: 'この投稿を削除する権限がありません' });
      }

      // CUSTOM: Autumn側のファイル削除はベストエフォート。失敗しても投稿自体の削除は継続する
      // (album-apiの写真削除と同様の方針)。Autumn削除APIの呼び出しは実装時に
      // album-api/storage-apiの既存削除パターンを参照して追加する。
      await mongoService.deleteGameClip(serverId, id);
      return reply.code(204).send();
    } catch (error) {
      console.error('Error deleting game clip:', error);
      return reply.code(500).send({ error: 'Failed to delete game clip' });
    }
  });

  // ---- Likes ----

  fastify.post('/gameclips/:id/like', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Unauthorized' });
    const { id } = request.params as { id: string };
    const { serverId, id: userId } = request.user;

    try {
      const result = await mongoService.toggleLike(serverId, id, userId);
      if (!result) return reply.code(404).send({ error: 'Game clip not found' });

      broadcast(serverId, { type: 'like_updated', gameClipId: id, likeCount: result.likeCount });
      return reply.send(result);
    } catch (error) {
      console.error('Error toggling like:', error);
      return reply.code(500).send({ error: 'Failed to toggle like' });
    }
  });

  // ---- Comments ----

  fastify.get('/gameclips/:id/comments', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Unauthorized' });
    const { id } = request.params as { id: string };

    try {
      const gameClip = await mongoService.getGameClip(request.user.serverId, id);
      if (!gameClip) return reply.code(404).send({ error: 'Game clip not found' });

      const comments = await mongoService.listComments(id);
      return reply.send(comments.map(serializeComment));
    } catch (error) {
      console.error('Error listing comments:', error);
      return reply.code(500).send({ error: 'Failed to list comments' });
    }
  });

  fastify.post('/gameclips/:id/comments', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Unauthorized' });
    const { id } = request.params as { id: string };
    const { serverId, id: userId } = request.user;

    const parsed = addCommentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request body', details: parsed.error.issues });
    }

    try {
      const gameClip = await mongoService.getGameClip(serverId, id);
      if (!gameClip) return reply.code(404).send({ error: 'Game clip not found' });
      if (!gameClip.allowComments) {
        return reply.code(403).send({ error: 'この投稿はコメントが許可されていません' });
      }

      const comment = await mongoService.addComment(id, serverId, { body: parsed.data.body, createdBy: userId });
      const updated = await mongoService.getGameClip(serverId, id);

      broadcast(serverId, {
        type: 'comment_added',
        gameClipId: id,
        commentCount: updated?.commentCount ?? gameClip.commentCount + 1,
        comment: {
          id: comment._id.toString(),
          body: comment.body,
          createdBy: comment.createdBy,
          createdAt: comment.createdAt.toISOString(),
        },
      });

      return reply.code(201).send(serializeComment(comment));
    } catch (error) {
      if (error instanceof CommentLimitExceededError) {
        return reply.code(409).send({ error: error.message });
      }
      console.error('Error adding comment:', error);
      return reply.code(500).send({ error: 'Failed to add comment' });
    }
  });
};
