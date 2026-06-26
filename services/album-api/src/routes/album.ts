import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  MongoDBService,
  Album,
  AlbumPhoto,
  VIEW_PERMISSIONS,
  EDIT_PERMISSIONS,
} from '../services/mongodb.service';
import { MinioService } from '../services/minio.service';
import { config } from '../config';

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be in YYYY-MM-DD format');

const createCategorySchema = z.object({
  name: z.string().min(1).max(100),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'color must be a #rrggbb hex value'),
});

const createAlbumSchema = z.object({
  title: z.string().min(1).max(200),
  date: dateSchema,
  categoryIds: z.array(z.string()).max(50).default([]),
  viewPermission: z.enum(VIEW_PERMISSIONS).default('anyone'),
  viewMemberIds: z.array(z.string()).max(500).default([]),
  editPermission: z.enum(EDIT_PERMISSIONS).default('creator_only'),
  editMemberIds: z.array(z.string()).max(500).default([]),
});

const updateAlbumSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  date: dateSchema.optional(),
  categoryIds: z.array(z.string()).max(50).optional(),
  viewPermission: z.enum(VIEW_PERMISSIONS).optional(),
  viewMemberIds: z.array(z.string()).max(500).optional(),
  editPermission: z.enum(EDIT_PERMISSIONS).optional(),
  editMemberIds: z.array(z.string()).max(500).optional(),
});

const listByDateQuerySchema = z.object({
  date: dateSchema,
});

const dateColorsQuerySchema = z.object({
  from: dateSchema,
  to: dateSchema,
});

const searchQuerySchema = z.object({
  title: z.string().optional(),
  dateFrom: dateSchema.optional(),
  dateTo: dateSchema.optional(),
  // CUSTOM: クエリ文字列はカンマ区切りで受け取る(?categoryIds=a,b,c)
  categoryIds: z
    .string()
    .optional()
    .transform((value) => (value ? value.split(',').filter(Boolean) : undefined)),
});

function serializeAlbum(album: Album) {
  const { _id, ...rest } = album;
  return { id: _id.toString(), ...rest };
}

// CUSTOM: objectName(MinIO上の内部キー)はクライアントに公開しない。
// クライアントはfileIdから/photos/:fileId/fileのURLを組み立てる
function serializePhoto(photo: AlbumPhoto) {
  const { _id, albumId, objectName, ...rest } = photo;
  return { id: _id.toString(), albumId: albumId.toString(), ...rest };
}

function canView(album: Album, userId: string): boolean {
  return (
    album.viewPermission === 'anyone' ||
    album.createdBy === userId ||
    album.viewMemberIds.includes(userId)
  );
}

// CUSTOM: 写真の追加/削除、設定変更、アルバム削除に共通して使う編集可否判定。
// 作成者は常に許可、'anyone'なら誰でも、'members'なら指定メンバーのみ許可する。
function canEdit(album: Album, userId: string): boolean {
  return (
    album.createdBy === userId ||
    album.editPermission === 'anyone' ||
    (album.editPermission === 'members' && album.editMemberIds.includes(userId))
  );
}

// CUSTOM: mongoService/minioServiceはindex.tsで1つだけ生成し、認証ありのこのルートと
// 認証なしのalbumFileRoutesの両方に渡す(stamp-apiと同じパターン、Mongo接続の重複を避ける)
export function createAlbumRoutes(
  mongoService: MongoDBService,
  minioService: MinioService,
): FastifyPluginAsync {
  return async (fastify) => {
  // ---- Categories ----

  fastify.get('/categories', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Unauthorized' });

    try {
      const categories = await mongoService.listCategories(request.user.serverId);
      return reply.send(
        categories.map(({ _id, ...rest }) => ({ id: _id.toString(), ...rest })),
      );
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

  // ---- Albums ----

  // CUSTOM: カレンダー検索用。指定日の閲覧可能なアルバム一覧を返す
  fastify.get('/albums', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Unauthorized' });

    const parsed = listByDateQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid query parameters', details: parsed.error.issues });
    }

    try {
      const albums = await mongoService.listAlbumsByDate(
        request.user.serverId,
        parsed.data.date,
        request.user.id,
      );
      return reply.send(albums.map(serializeAlbum));
    } catch (error) {
      console.error('Error listing albums:', error);
      return reply.code(500).send({ error: 'Failed to list albums' });
    }
  });

  // CUSTOM: ミニカレンダーの日付色付け用
  fastify.get('/albums/dates', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Unauthorized' });

    const parsed = dateColorsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid query parameters', details: parsed.error.issues });
    }

    try {
      const dateColors = await mongoService.listDateColors(
        request.user.serverId,
        parsed.data.from,
        parsed.data.to,
        request.user.id,
      );
      return reply.send(dateColors);
    } catch (error) {
      console.error('Error listing date colors:', error);
      return reply.code(500).send({ error: 'Failed to list date colors' });
    }
  });

  // CUSTOM: 条件検索(アルバム名・作成日・カテゴリ)。未入力の項目は無視され、
  // 入力された項目はAND結合(categoryIdsのみ複数選択時はOR)される
  fastify.get('/albums/search', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Unauthorized' });

    const parsed = searchQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid query parameters', details: parsed.error.issues });
    }

    try {
      const albums = await mongoService.searchAlbums(
        request.user.serverId,
        parsed.data,
        request.user.id,
      );
      return reply.send(albums.map(serializeAlbum));
    } catch (error) {
      console.error('Error searching albums:', error);
      return reply.code(500).send({ error: 'Failed to search albums' });
    }
  });

  fastify.post('/albums', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Unauthorized' });

    const parsed = createAlbumSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request body', details: parsed.error.issues });
    }

    const { serverId, id: userId } = request.user;

    try {
      // CUSTOM: 作成者は常に閲覧/編集メンバーに含める
      const viewMemberIds = Array.from(new Set([userId, ...parsed.data.viewMemberIds]));
      const editMemberIds = Array.from(new Set([userId, ...parsed.data.editMemberIds]));

      const album = await mongoService.createAlbum({
        ...parsed.data,
        viewMemberIds,
        editMemberIds,
        serverId,
        createdBy: userId,
      });
      return reply.code(201).send(serializeAlbum(album));
    } catch (error) {
      console.error('Error creating album:', error);
      return reply.code(500).send({ error: 'Failed to create album' });
    }
  });

  fastify.get('/albums/:id', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Unauthorized' });

    const { id } = request.params as { id: string };

    try {
      const album = await mongoService.getAlbum(request.user.serverId, id);
      if (!album) return reply.code(404).send({ error: 'Album not found' });
      if (!canView(album, request.user.id)) {
        return reply.code(403).send({ error: 'このアルバムを閲覧する権限がありません' });
      }
      return reply.send(serializeAlbum(album));
    } catch (error) {
      console.error('Error getting album:', error);
      return reply.code(500).send({ error: 'Failed to get album' });
    }
  });

  fastify.put('/albums/:id', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Unauthorized' });

    const { id } = request.params as { id: string };
    const { serverId, id: userId } = request.user;

    const parsed = updateAlbumSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request body', details: parsed.error.issues });
    }

    try {
      const existing = await mongoService.getAlbum(serverId, id);
      if (!existing) return reply.code(404).send({ error: 'Album not found' });

      if (!canEdit(existing, userId)) {
        return reply.code(403).send({ error: 'このアルバムを編集する権限がありません' });
      }

      // CUSTOM: 閲覧/編集権限自体の変更は作成者のみ許可(他者が'anyone'に書き換えて
      // 作成者以外をロックアウトする/逆に権限を奪うのを防ぐ)
      const changesPermissions =
        parsed.data.viewPermission !== undefined ||
        parsed.data.viewMemberIds !== undefined ||
        parsed.data.editPermission !== undefined ||
        parsed.data.editMemberIds !== undefined;
      if (changesPermissions && existing.createdBy !== userId) {
        return reply.code(403).send({ error: '権限設定の変更は作成者のみ行えます' });
      }

      const updates = { ...parsed.data };
      if (updates.viewMemberIds) {
        updates.viewMemberIds = Array.from(new Set([existing.createdBy, ...updates.viewMemberIds]));
      }
      if (updates.editMemberIds) {
        updates.editMemberIds = Array.from(new Set([existing.createdBy, ...updates.editMemberIds]));
      }

      const updated = await mongoService.updateAlbum(serverId, id, updates);
      if (!updated) return reply.code(500).send({ error: 'Failed to update album' });
      return reply.send(serializeAlbum(updated));
    } catch (error) {
      console.error('Error updating album:', error);
      return reply.code(500).send({ error: 'Failed to update album' });
    }
  });

  fastify.delete('/albums/:id', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Unauthorized' });

    const { id } = request.params as { id: string };
    const { serverId, id: userId } = request.user;

    try {
      const existing = await mongoService.getAlbum(serverId, id);
      if (!existing) return reply.code(404).send({ error: 'Album not found' });

      if (!canEdit(existing, userId)) {
        return reply.code(403).send({ error: 'このアルバムを削除する権限がありません' });
      }

      const deletedPhotos = await mongoService.deleteAlbum(serverId, id);
      if (!deletedPhotos) return reply.code(404).send({ error: 'Album not found' });

      await Promise.all(
        deletedPhotos.map((photo) =>
          minioService.deleteFile(photo.objectName).catch((error) => {
            console.error('Error deleting album photo file from MinIO:', error);
          }),
        ),
      );
      return reply.code(204).send();
    } catch (error) {
      console.error('Error deleting album:', error);
      return reply.code(500).send({ error: 'Failed to delete album' });
    }
  });

  // ---- Photos ----

  fastify.get('/albums/:id/photos', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Unauthorized' });

    const { id } = request.params as { id: string };

    try {
      const album = await mongoService.getAlbum(request.user.serverId, id);
      if (!album) return reply.code(404).send({ error: 'Album not found' });
      if (!canView(album, request.user.id)) {
        return reply.code(403).send({ error: 'このアルバムを閲覧する権限がありません' });
      }

      const photos = await mongoService.listPhotos(id);
      return reply.send(photos.map(serializePhoto));
    } catch (error) {
      console.error('Error listing photos:', error);
      return reply.code(500).send({ error: 'Failed to list photos' });
    }
  });

  // CUSTOM: multipart/form-data。"file"がアップロードするバイト列、"type"
  // ("Image"|"Video"|"File")・"width"・"height"はクライアント側(ブラウザ)で
  // 読み取った寸法をそのまま受け取る付加フィールド(album-api自身は寸法を解析しない)
  fastify.post('/albums/:id/photos', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Unauthorized' });

    const { id } = request.params as { id: string };
    const { serverId, id: userId } = request.user;

    try {
      const album = await mongoService.getAlbum(serverId, id);
      if (!album) return reply.code(404).send({ error: 'Album not found' });
      if (!canEdit(album, userId)) {
        return reply.code(403).send({ error: 'このアルバムに写真を追加する権限がありません' });
      }

      let fileBuffer: Buffer | undefined;
      let filename = 'file';
      let contentType = 'application/octet-stream';
      let metadataType = 'File';
      let width: number | undefined;
      let height: number | undefined;

      try {
        for await (const part of request.parts()) {
          if (part.type === 'file') {
            fileBuffer = await part.toBuffer();
            contentType = part.mimetype || contentType;
            filename = part.filename || filename;
          } else if (part.fieldname === 'type' && typeof part.value === 'string') {
            metadataType = part.value;
          } else if (part.fieldname === 'width' && typeof part.value === 'string') {
            width = Number(part.value);
          } else if (part.fieldname === 'height' && typeof part.value === 'string') {
            height = Number(part.value);
          }
        }
      } catch (error) {
        console.error('Error parsing photo upload:', error);
        return reply.code(400).send({ error: 'アップロードの解析に失敗しました(サイズ上限を超えていないか確認してください)' });
      }

      if (!fileBuffer) {
        return reply.code(400).send({ error: 'file is required' });
      }
      if (fileBuffer.length > config.maxFileSizeBytes) {
        return reply.code(413).send({ error: 'ファイルサイズが大きすぎます' });
      }

      const fileId = mongoService.generateFileId();
      const objectName = `albums/${fileId}`;
      await minioService.uploadFile(objectName, fileBuffer, contentType);

      const metadata: Record<string, unknown> = { type: metadataType };
      if (width !== undefined && !Number.isNaN(width)) metadata.width = width;
      if (height !== undefined && !Number.isNaN(height)) metadata.height = height;

      const photo = await mongoService.addPhoto({
        albumId: id,
        serverId,
        fileId,
        objectName,
        filename,
        contentType,
        metadata,
        size: fileBuffer.length,
        uploadedBy: userId,
      });
      return reply.code(201).send(serializePhoto(photo));
    } catch (error) {
      console.error('Error adding photo:', error);
      return reply.code(500).send({ error: 'Failed to add photo' });
    }
  });

  fastify.delete('/albums/:id/photos/:photoId', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Unauthorized' });

    const { id, photoId } = request.params as { id: string; photoId: string };
    const { serverId, id: userId } = request.user;

    try {
      const album = await mongoService.getAlbum(serverId, id);
      if (!album) return reply.code(404).send({ error: 'Album not found' });
      if (!canEdit(album, userId)) {
        return reply.code(403).send({ error: 'この写真を削除する権限がありません' });
      }

      const deleted = await mongoService.deletePhoto(id, photoId);
      if (!deleted) return reply.code(404).send({ error: 'Photo not found' });

      await minioService.deleteFile(deleted.objectName).catch((error) => {
        console.error('Error deleting photo file from MinIO:', error);
      });
      return reply.code(204).send();
    } catch (error) {
      console.error('Error deleting photo:', error);
      return reply.code(500).send({ error: 'Failed to delete photo' });
    }
  });
  };
}
