import { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { createReadStream } from 'fs';
import { stat as fsStat } from 'fs/promises';
import { MongoDBService, McServer } from '../services/mongodb.service';
import {
  FileOpError,
  listEntries,
  readTextFile,
  writeTextFile,
  deleteEntry,
  createFolder,
  renameEntry,
  saveUploadedFile,
  resolveServerPath,
  backupFolderBeforeReplace,
} from '../services/files.service';
import { extractZipToFolderReplacing, ZipExtractError } from '../services/zip-extract.service';
import { requireAdmin, AuthenticatedUser } from '../plugins/auth';
import { ensureServerIdMatches } from './minecraft';

const pathQuerySchema = z.object({ path: z.string().optional().default('') });
const writeTextSchema = z.object({ path: z.string().min(1), content: z.string() });
const pathBodySchema = z.object({ path: z.string().min(1) });
const renameSchema = z.object({ path: z.string().min(1), newPath: z.string().min(1) });

// CUSTOM: 起動中のサーバーのworld/modsを書き換えるとデータ損壊のリスクがあるため、
// 変更系操作はサーバーが停止状態(起動・起動中・停止中以外)の時のみ許可する。
const RUNNING_LIKE_STATUSES = new Set(['RUNNING', 'STARTING', 'STOPPING']);

interface GuardRequest {
  user: AuthenticatedUser | null;
  params: { serverId: string; mcId: string };
}

function handleFileOpError(error: unknown, reply: FastifyReply) {
  if (error instanceof FileOpError) {
    return reply.code(error.statusCode).send({ error: error.message });
  }
  throw error;
}

export const minecraftFileRoutes: FastifyPluginAsync = async (fastify) => {
  const mongoService = new MongoDBService();

  fastify.addHook('onReady', async () => {
    await mongoService.connect();
  });

  fastify.addHook('onClose', async () => {
    await mongoService.disconnect();
  });

  // CUSTOM: 全エンドポイント共通の前処理。認証・serverId一致・admin・サーバー存在を確認し、
  // mustBeStopped=trueの場合は起動中なら409で拒否する。
  async function guard(
    request: GuardRequest,
    reply: FastifyReply,
    mustBeStopped: boolean,
  ): Promise<McServer | null> {
    if (!request.user) {
      reply.code(401).send({ error: 'Unauthorized' });
      return null;
    }
    if (!ensureServerIdMatches(request.user, request.params.serverId)) {
      reply.code(400).send({ error: 'serverId mismatch' });
      return null;
    }
    if (!requireAdmin(request)) {
      reply.code(403).send({ error: 'ManageServer permission required' });
      return null;
    }
    const server = await mongoService.getServer(request.params.serverId, request.params.mcId);
    if (!server) {
      reply.code(404).send({ error: 'Not found' });
      return null;
    }
    if (mustBeStopped && RUNNING_LIKE_STATUSES.has(server.status)) {
      reply.code(409).send({ error: 'サーバーを停止してから操作してください' });
      return null;
    }
    return server;
  }

  // ---- List ----
  fastify.get<{ Params: { serverId: string; mcId: string }; Querystring: { path?: string } }>(
    '/servers/:serverId/minecraft/:mcId/files',
    async (request, reply) => {
      const server = await guard(request, reply, false);
      if (!server) return;
      const parsed = pathQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

      try {
        return await listEntries(request.params.mcId, parsed.data.path);
      } catch (error) {
        return handleFileOpError(error, reply);
      }
    },
  );

  // ---- Read text ----
  fastify.get<{ Params: { serverId: string; mcId: string }; Querystring: { path?: string } }>(
    '/servers/:serverId/minecraft/:mcId/files/text',
    async (request, reply) => {
      const server = await guard(request, reply, false);
      if (!server) return;
      const parsed = pathQuerySchema.safeParse(request.query);
      if (!parsed.success || !parsed.data.path) return reply.code(400).send({ error: 'path is required' });

      try {
        const content = await readTextFile(request.params.mcId, parsed.data.path);
        return { content };
      } catch (error) {
        return handleFileOpError(error, reply);
      }
    },
  );

  // ---- Write text ----
  fastify.post<{ Params: { serverId: string; mcId: string }; Body: unknown }>(
    '/servers/:serverId/minecraft/:mcId/files/text',
    async (request, reply) => {
      const server = await guard(request, reply, true);
      if (!server) return;
      const parsed = writeTextSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

      try {
        await writeTextFile(request.params.mcId, parsed.data.path, parsed.data.content);
        return reply.code(204).send();
      } catch (error) {
        return handleFileOpError(error, reply);
      }
    },
  );

  // ---- Download ----
  fastify.get<{ Params: { serverId: string; mcId: string }; Querystring: { path?: string } }>(
    '/servers/:serverId/minecraft/:mcId/files/download',
    async (request, reply) => {
      const server = await guard(request, reply, false);
      if (!server) return;
      const parsed = pathQuerySchema.safeParse(request.query);
      if (!parsed.success || !parsed.data.path) return reply.code(400).send({ error: 'path is required' });

      try {
        const filePath = resolveServerPath(request.params.mcId, parsed.data.path);
        const stat = await fsStat(filePath);
        if (stat.isDirectory()) return reply.code(400).send({ error: 'フォルダはダウンロードできません' });
        const filename = parsed.data.path.split('/').pop() || 'file';
        reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
        reply.header('Content-Length', stat.size);
        return reply.send(createReadStream(filePath));
      } catch (error) {
        return handleFileOpError(error, reply);
      }
    },
  );

  // ---- Upload single file ----
  fastify.post<{ Params: { serverId: string; mcId: string } }>(
    '/servers/:serverId/minecraft/:mcId/files/upload',
    async (request, reply) => {
      const server = await guard(request, reply, true);
      if (!server) return;

      let destPath: string | null = null;
      for await (const part of request.parts()) {
        if (part.type === 'field' && part.fieldname === 'path') {
          destPath = String(part.value);
          continue;
        }
        if (part.type === 'file') {
          if (!destPath) {
            part.file.resume();
            return reply.code(400).send({ error: 'path field is required before file' });
          }
          try {
            await saveUploadedFile(request.params.mcId, destPath, part.file);
          } catch (error) {
            return handleFileOpError(error, reply);
          }
        }
      }
      if (!destPath) return reply.code(400).send({ error: 'file is required' });
      return reply.code(204).send();
    },
  );

  // ---- Upload zip and replace a folder's contents ----
  fastify.post<{ Params: { serverId: string; mcId: string } }>(
    '/servers/:serverId/minecraft/:mcId/files/upload-zip',
    async (request, reply) => {
      const server = await guard(request, reply, true);
      if (!server) return;

      let targetPath: string | null = null;
      let handled = false;
      for await (const part of request.parts()) {
        if (part.type === 'field' && part.fieldname === 'targetPath') {
          targetPath = String(part.value);
          continue;
        }
        if (part.type === 'file') {
          if (!targetPath) {
            part.file.resume();
            return reply.code(400).send({ error: 'targetPath field is required before file' });
          }
          try {
            const targetDir = resolveServerPath(request.params.mcId, targetPath);
            await backupFolderBeforeReplace(request.params.mcId, targetPath);
            await extractZipToFolderReplacing(part.file, targetDir);
            handled = true;
          } catch (error) {
            if (error instanceof ZipExtractError) {
              return reply.code(400).send({ error: error.message });
            }
            return handleFileOpError(error, reply);
          }
        }
      }
      if (!handled) return reply.code(400).send({ error: 'targetPath and file are required' });
      return reply.code(204).send();
    },
  );

  // ---- Delete (file or folder, recursive) ----
  fastify.delete<{ Params: { serverId: string; mcId: string }; Body: unknown }>(
    '/servers/:serverId/minecraft/:mcId/files',
    async (request, reply) => {
      const server = await guard(request, reply, true);
      if (!server) return;
      const parsed = pathBodySchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

      try {
        await deleteEntry(request.params.mcId, parsed.data.path);
        return reply.code(204).send();
      } catch (error) {
        return handleFileOpError(error, reply);
      }
    },
  );

  // ---- Create folder ----
  fastify.post<{ Params: { serverId: string; mcId: string }; Body: unknown }>(
    '/servers/:serverId/minecraft/:mcId/folders',
    async (request, reply) => {
      const server = await guard(request, reply, true);
      if (!server) return;
      const parsed = pathBodySchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

      try {
        await createFolder(request.params.mcId, parsed.data.path);
        return reply.code(204).send();
      } catch (error) {
        return handleFileOpError(error, reply);
      }
    },
  );

  // ---- Rename / move ----
  fastify.patch<{ Params: { serverId: string; mcId: string }; Body: unknown }>(
    '/servers/:serverId/minecraft/:mcId/files',
    async (request, reply) => {
      const server = await guard(request, reply, true);
      if (!server) return;
      const parsed = renameSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

      try {
        await renameEntry(request.params.mcId, parsed.data.path, parsed.data.newPath);
        return reply.code(204).send();
      } catch (error) {
        return handleFileOpError(error, reply);
      }
    },
  );
};
