import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { MongoDBService, MC_SERVER_TYPES, McServer, toPublicMcServer } from '../services/mongodb.service';
import { DockerService } from '../services/docker.service';
import { RconService, RconError } from '../services/rcon.service';
import { requireAdmin } from '../plugins/auth';
import { config } from '../config';

const RCON_INTERNAL_PORT = 25575;

const createServerSchema = z.object({
  name: z.string().min(1).max(50),
  version: z.string().min(1).max(20),
  type: z.enum(MC_SERVER_TYPES),
  memory: z
    .string()
    .regex(/^[0-9]+[MG]$/, 'memory must look like "2G" or "1024M"'),
  port: z.coerce.number().int().min(1024).max(65535),
});

const commandSchema = z.object({
  command: z.string().min(1).max(500),
});

const stopSchema = z.object({
  force: z.boolean().optional().default(false),
});

function serializeServer(server: McServer) {
  const { _id, ...rest } = toPublicMcServer(server);
  return { id: _id.toString(), ...rest };
}

// CUSTOM: URLの:serverIdとX-Server-Idヘッダーから認証済みのserverIdが一致しているか確認する。
// authPluginはヘッダー側のserverIdでStoatへの所属確認・権限計算を行っているため、
// URL側のserverIdとズレていると別サーバーに対する権限を誤って適用してしまう。
function ensureServerIdMatches(requestUser: { serverId: string } | null, urlServerId: string): boolean {
  return requestUser?.serverId === urlServerId;
}

export const minecraftRoutes: FastifyPluginAsync = async (fastify) => {
  const mongoService = new MongoDBService();
  const dockerService = new DockerService();
  const rconService = new RconService();

  fastify.addHook('onReady', async () => {
    await mongoService.connect();
  });

  fastify.addHook('onClose', async () => {
    await mongoService.disconnect();
  });

  // ---- List ----
  fastify.get<{ Params: { serverId: string } }>('/servers/:serverId/minecraft', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Unauthorized' });
    if (!ensureServerIdMatches(request.user, request.params.serverId)) {
      return reply.code(400).send({ error: 'serverId mismatch' });
    }

    const servers = await mongoService.listServers(request.params.serverId);
    return servers.map(serializeServer);
  });

  // ---- Create ----
  fastify.post<{ Params: { serverId: string }; Body: unknown }>(
    '/servers/:serverId/minecraft',
    async (request, reply) => {
      if (!request.user) return reply.code(401).send({ error: 'Unauthorized' });
      if (!ensureServerIdMatches(request.user, request.params.serverId)) {
        return reply.code(400).send({ error: 'serverId mismatch' });
      }
      if (!requireAdmin(request)) {
        return reply.code(403).send({ error: 'ManageServer permission required' });
      }

      const parsed = createServerSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }
      const { name, version, type, memory, port } = parsed.data;

      if (await mongoService.isPortTaken(request.params.serverId, port)) {
        return reply.code(409).send({ error: `Port ${port} is already used by another server in this Stoat server` });
      }

      const mcId = crypto.randomBytes(6).toString('hex');
      const rconPassword = crypto.randomBytes(16).toString('hex');
      const containerName = `mc-${mcId}`;

      await fs.mkdir(path.join(config.mcDataRoot, mcId), { recursive: true });

      const created = await mongoService.createServer({
        serverId: request.params.serverId,
        mcId,
        name,
        version,
        type,
        memory,
        port,
        rconPort: RCON_INTERNAL_PORT,
        rconPassword,
        containerName,
        createdBy: request.user.id,
      });

      return reply.code(201).send(serializeServer(created));
    },
  );

  // ---- Get one (status refreshed from Docker if a container exists) ----
  fastify.get<{ Params: { serverId: string; mcId: string } }>(
    '/servers/:serverId/minecraft/:mcId',
    async (request, reply) => {
      if (!request.user) return reply.code(401).send({ error: 'Unauthorized' });
      if (!ensureServerIdMatches(request.user, request.params.serverId)) {
        return reply.code(400).send({ error: 'serverId mismatch' });
      }

      const server = await mongoService.getServer(request.params.serverId, request.params.mcId);
      if (!server) return reply.code(404).send({ error: 'Not found' });

      if (server.containerId) {
        const liveStatus = await dockerService.inspectStatus(server.containerId);
        if (liveStatus !== server.status) {
          const updated = await mongoService.updateServer(request.params.serverId, request.params.mcId, {
            status: liveStatus,
          });
          return serializeServer(updated ?? server);
        }
      }

      return serializeServer(server);
    },
  );

  // ---- Delete ----
  fastify.delete<{ Params: { serverId: string; mcId: string }; Querystring: { confirm?: string } }>(
    '/servers/:serverId/minecraft/:mcId',
    async (request, reply) => {
      if (!request.user) return reply.code(401).send({ error: 'Unauthorized' });
      if (!ensureServerIdMatches(request.user, request.params.serverId)) {
        return reply.code(400).send({ error: 'serverId mismatch' });
      }
      if (!requireAdmin(request)) {
        return reply.code(403).send({ error: 'ManageServer permission required' });
      }
      // CUSTOM: フロントの確認ダイアログに頼れるPhase1のUIはまだ無いため、
      // バックエンド側でも明示的なconfirm=trueクエリを安全策として要求する
      if (request.query.confirm !== 'true') {
        return reply.code(400).send({ error: 'Pass ?confirm=true to delete this server and its data' });
      }

      const server = await mongoService.getServer(request.params.serverId, request.params.mcId);
      if (!server) return reply.code(404).send({ error: 'Not found' });

      if (server.containerId) {
        await dockerService.remove(server.containerId).catch(() => undefined);
      }
      await fs.rm(path.join(config.mcDataRoot, server.mcId), { recursive: true, force: true });
      await mongoService.deleteServer(request.params.serverId, request.params.mcId);

      return reply.code(204).send();
    },
  );

  // ---- Start ----
  fastify.post<{ Params: { serverId: string; mcId: string } }>(
    '/servers/:serverId/minecraft/:mcId/start',
    async (request, reply) => {
      if (!request.user) return reply.code(401).send({ error: 'Unauthorized' });
      if (!ensureServerIdMatches(request.user, request.params.serverId)) {
        return reply.code(400).send({ error: 'serverId mismatch' });
      }
      if (!requireAdmin(request)) {
        return reply.code(403).send({ error: 'ManageServer permission required' });
      }

      const server = await mongoService.getServer(request.params.serverId, request.params.mcId);
      if (!server) return reply.code(404).send({ error: 'Not found' });

      // CUSTOM: 冪等にする。既にRUNNINGなら現状を返すだけ
      if (server.containerId) {
        const liveStatus = await dockerService.inspectStatus(server.containerId);
        if (liveStatus === 'RUNNING') {
          return serializeServer(server);
        }
      }

      await mongoService.updateServer(request.params.serverId, request.params.mcId, { status: 'STARTING' });

      try {
        let containerId = server.containerId;
        if (!containerId) {
          containerId = await dockerService.createContainer(server);
          // CUSTOM: createContainer成功直後に必ず保存する。start()がここで失敗しても
          // containerIdをDBに残しておけば、リトライ時に同名コンテナを再作成しようとして
          // 409 Conflictになることを避けられる(start()だけをやり直せる)。
          await mongoService.updateServer(request.params.serverId, request.params.mcId, { containerId });
        }
        await dockerService.start(containerId);
        const updated = await mongoService.updateServer(request.params.serverId, request.params.mcId, {
          containerId,
          status: 'RUNNING',
        });
        return serializeServer(updated!);
      } catch (error) {
        await mongoService.updateServer(request.params.serverId, request.params.mcId, { status: 'ERROR' });
        request.log.error(error);
        return reply.code(500).send({ error: 'Failed to start Minecraft server container' });
      }
    },
  );

  // ---- Stop ----
  fastify.post<{ Params: { serverId: string; mcId: string }; Body: unknown }>(
    '/servers/:serverId/minecraft/:mcId/stop',
    async (request, reply) => {
      if (!request.user) return reply.code(401).send({ error: 'Unauthorized' });
      if (!ensureServerIdMatches(request.user, request.params.serverId)) {
        return reply.code(400).send({ error: 'serverId mismatch' });
      }
      if (!requireAdmin(request)) {
        return reply.code(403).send({ error: 'ManageServer permission required' });
      }

      const parsed = stopSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }

      const server = await mongoService.getServer(request.params.serverId, request.params.mcId);
      if (!server) return reply.code(404).send({ error: 'Not found' });

      if (!server.containerId) {
        return serializeServer(server); // 冪等: コンテナがまだ無いなら何もしない
      }

      const liveStatus = await dockerService.inspectStatus(server.containerId);
      if (liveStatus === 'STOPPED') {
        const updated = await mongoService.updateServer(request.params.serverId, request.params.mcId, {
          status: 'STOPPED',
        });
        return serializeServer(updated ?? server);
      }

      await mongoService.updateServer(request.params.serverId, request.params.mcId, { status: 'STOPPING' });

      try {
        if (parsed.data.force) {
          await dockerService.stop(server.containerId, 0);
        } else {
          // CUSTOM: まずRCON経由で `stop` コマンドを送り、安全にワールド保存させてから
          // dockerService.stop()のタイムアウト猶予(10秒)に賭ける。RCONが失敗しても
          // docker stopへフォールバックするので致命的ではない。
          await rconService
            .sendCommand(server.containerName, server.rconPort, server.rconPassword, 'stop')
            .catch(() => undefined);
          await dockerService.stop(server.containerId, 10);
        }
        const updated = await mongoService.updateServer(request.params.serverId, request.params.mcId, {
          status: 'STOPPED',
        });
        return serializeServer(updated!);
      } catch (error) {
        await mongoService.updateServer(request.params.serverId, request.params.mcId, { status: 'ERROR' });
        request.log.error(error);
        return reply.code(500).send({ error: 'Failed to stop Minecraft server container' });
      }
    },
  );

  // ---- Command (RCON) ----
  fastify.post<{ Params: { serverId: string; mcId: string }; Body: unknown }>(
    '/servers/:serverId/minecraft/:mcId/command',
    async (request, reply) => {
      if (!request.user) return reply.code(401).send({ error: 'Unauthorized' });
      if (!ensureServerIdMatches(request.user, request.params.serverId)) {
        return reply.code(400).send({ error: 'serverId mismatch' });
      }
      if (!requireAdmin(request)) {
        return reply.code(403).send({ error: 'ManageServer permission required' });
      }

      const parsed = commandSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }

      const server = await mongoService.getServer(request.params.serverId, request.params.mcId);
      if (!server) return reply.code(404).send({ error: 'Not found' });
      if (!server.containerId) {
        return reply.code(409).send({ error: 'Server has not been started yet' });
      }

      try {
        const response = await rconService.sendCommand(
          server.containerName,
          server.rconPort,
          server.rconPassword,
          parsed.data.command,
        );
        return { response };
      } catch (error) {
        if (error instanceof RconError) {
          return reply.code(502).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  // ---- Console (WebSocket log stream) ----
  // CUSTOM: Phase 1ではフロントが無いため一律admin限定。将来フロント実装時には
  // 「閲覧は全メンバー可、コマンド送信のみadmin限定」へ緩和する想定。
  fastify.get<{ Params: { serverId: string; mcId: string } }>(
    '/servers/:serverId/minecraft/:mcId/console',
    { websocket: true },
    async (connection, request) => {
      if (!request.user || !ensureServerIdMatches(request.user, request.params.serverId) || !requireAdmin(request)) {
        connection.close(1008, 'Forbidden');
        return;
      }

      const server = await mongoService.getServer(request.params.serverId, request.params.mcId);
      if (!server || !server.containerId) {
        connection.close(1008, 'Server not found or not started');
        return;
      }

      const stopStreaming = await dockerService.streamLogs(server.containerId, (line) => {
        if (connection.readyState === connection.OPEN) {
          connection.send(line);
        }
      });

      connection.on('close', () => stopStreaming());
    },
  );
};
