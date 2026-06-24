import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { MongoDBService, MC_SERVER_TYPES, McServer, toPublicMcServer } from '../services/mongodb.service';
import { DockerService } from '../services/docker.service';
import { RconService, RconError } from '../services/rcon.service';
import { extractZipStream, removeExtractedDir, ZipExtractError } from '../services/zip-extract.service';
import { requireAdmin } from '../plugins/auth';
import { config } from '../config';

const RCON_INTERNAL_PORT = 25575;

const memorySchema = z
  .string()
  .regex(/^[0-9]+[MG]$/, 'memory must look like "2G" or "1024M"');

const createServerSchema = z.object({
  name: z.string().min(1).max(50),
  version: z.string().min(1).max(20),
  type: z.enum(MC_SERVER_TYPES),
  memory: memorySchema,
  port: z.coerce.number().int().min(1024).max(65535),
});

// CUSTOM: アップロードモードではversionはitzgの起動ロジックに使われない
// (TYPE=CUSTOMで既存jarをそのまま起動するため)、表示用ラベルとして任意入力にする
const uploadFieldsSchema = z.object({
  name: z.string().min(1).max(50),
  type: z.enum(MC_SERVER_TYPES),
  version: z.string().max(20).optional().default(''),
  memory: memorySchema,
  port: z.coerce.number().int().min(1024).max(65535),
});

const selectJarSchema = z.object({
  jarPath: z.string().min(1).max(500),
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
export function ensureServerIdMatches(requestUser: { serverId: string } | null, urlServerId: string): boolean {
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

  // ---- Create from uploaded zip ----
  // CUSTOM: フロントはFormDataに name/type/memory/port を先にappendし、
  // zipファイルを最後にappendすること。テキストフィールドの検証(ポート重複含む)を
  // ファイル受信前に終わらせることで、不正な入力の場合は展開処理(高コスト)を
  // 一切走らせずに即400で返せる。
  fastify.post<{ Params: { serverId: string } }>(
    '/servers/:serverId/minecraft/upload',
    async (request, reply) => {
      if (!request.user) return reply.code(401).send({ error: 'Unauthorized' });
      if (!ensureServerIdMatches(request.user, request.params.serverId)) {
        return reply.code(400).send({ error: 'serverId mismatch' });
      }
      if (!requireAdmin(request)) {
        return reply.code(403).send({ error: 'ManageServer permission required' });
      }

      const fields: Record<string, string> = {};
      let mcId: string | null = null;
      let destRoot: string | null = null;
      let jarCandidates: string[] | null = null;
      let earlyError: { code: number; error: unknown } | null = null;

      try {
        for await (const part of request.parts()) {
          if (part.type === 'field') {
            fields[part.fieldname] = String(part.value);
            continue;
          }

          // part.type === 'file' (zip本体。フィールドはここまでに全て揃っている前提)
          const parsedFields = uploadFieldsSchema.safeParse(fields);
          if (!parsedFields.success) {
            part.file.resume(); // multipartパーサーを完了させるため未消費のまま破棄する
            earlyError = { code: 400, error: parsedFields.error.flatten() };
            break;
          }

          if (await mongoService.isPortTaken(request.params.serverId, parsedFields.data.port)) {
            part.file.resume();
            earlyError = {
              code: 409,
              error: `Port ${parsedFields.data.port} is already used by another server in this Stoat server`,
            };
            break;
          }

          mcId = crypto.randomBytes(6).toString('hex');
          destRoot = path.join(config.mcDataRoot, mcId);
          const result = await extractZipStream(part.file, destRoot);
          jarCandidates = result.jarCandidates;
        }
      } catch (error) {
        if (destRoot) await removeExtractedDir(destRoot);
        if (error instanceof ZipExtractError) {
          return reply.code(400).send({ error: error.message });
        }
        request.log.error(error);
        return reply.code(500).send({ error: 'Failed to process uploaded server' });
      }

      if (earlyError) {
        return reply.code(earlyError.code).send({ error: earlyError.error });
      }

      if (!mcId || !destRoot || jarCandidates === null) {
        return reply.code(400).send({ error: 'zip file is required' });
      }

      if (jarCandidates.length === 0) {
        await removeExtractedDir(destRoot);
        return reply.code(400).send({ error: 'サーバーjarファイルが見つかりません' });
      }

      const { name, type, version, memory, port } = uploadFieldsSchema.parse(fields);
      const rconPassword = crypto.randomBytes(16).toString('hex');
      const containerName = `mc-${mcId}`;

      const created = await mongoService.createUploadedServer({
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
        jarCandidates,
      });

      return reply.code(201).send(serializeServer(created));
    },
  );

  // ---- Select jar (resolve PENDING_JAR_SELECTION) ----
  fastify.post<{ Params: { serverId: string; mcId: string }; Body: unknown }>(
    '/servers/:serverId/minecraft/:mcId/select-jar',
    async (request, reply) => {
      if (!request.user) return reply.code(401).send({ error: 'Unauthorized' });
      if (!ensureServerIdMatches(request.user, request.params.serverId)) {
        return reply.code(400).send({ error: 'serverId mismatch' });
      }
      if (!requireAdmin(request)) {
        return reply.code(403).send({ error: 'ManageServer permission required' });
      }

      const parsed = selectJarSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }

      const server = await mongoService.getServer(request.params.serverId, request.params.mcId);
      if (!server) return reply.code(404).send({ error: 'Not found' });
      if (server.status !== 'PENDING_JAR_SELECTION' || !server.pendingJarCandidates) {
        return reply.code(409).send({ error: 'This server is not awaiting jar selection' });
      }

      // CUSTOM: candidatesはextractZipStream時点で実在を確認済みだが、念のため
      // 二重チェック(パストラバーサル・ファイル存在)を行う
      const dataRoot = path.resolve(config.mcDataRoot, server.mcId);
      const fullPath = path.resolve(dataRoot, parsed.data.jarPath);
      if (fullPath !== dataRoot && !fullPath.startsWith(dataRoot + path.sep)) {
        return reply.code(400).send({ error: 'invalid jarPath' });
      }
      try {
        await fs.access(fullPath);
      } catch {
        return reply.code(400).send({ error: 'jarファイルが見つかりません' });
      }

      const updated = await mongoService.finalizeJarSelection(
        request.params.serverId,
        request.params.mcId,
        parsed.data.jarPath,
      );
      if (!updated) {
        return reply.code(400).send({ error: 'jarPath is not one of the detected candidates' });
      }

      return serializeServer(updated);
    },
  );

  // ---- Change jar (UPLOAD作成済みサーバーが、選択し直したい場合に後から切り替える) ----
  // CUSTOM: select-jarはアップロード直後のPENDING_JAR_SELECTION状態でしか使えないため、
  // 「最初は動かないjarを選んでしまった」場合に切り替える手段がなかった。展開済みデータは
  // そのまま使い、jarパスとコンテナだけ差し替える(コンテナは次回起動時に新しいImage設定
  // (java8等)で再作成される)。
  fastify.post<{ Params: { serverId: string; mcId: string }; Body: unknown }>(
    '/servers/:serverId/minecraft/:mcId/change-jar',
    async (request, reply) => {
      if (!request.user) return reply.code(401).send({ error: 'Unauthorized' });
      if (!ensureServerIdMatches(request.user, request.params.serverId)) {
        return reply.code(400).send({ error: 'serverId mismatch' });
      }
      if (!requireAdmin(request)) {
        return reply.code(403).send({ error: 'ManageServer permission required' });
      }

      const parsed = selectJarSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }

      const server = await mongoService.getServer(request.params.serverId, request.params.mcId);
      if (!server) return reply.code(404).send({ error: 'Not found' });
      if (server.source !== 'UPLOAD') {
        return reply.code(400).send({ error: 'アップロードで作成したサーバーのみjarを切り替えられます' });
      }
      if (server.status === 'RUNNING' || server.status === 'STARTING' || server.status === 'STOPPING') {
        return reply.code(409).send({ error: 'サーバーを停止してから切り替えてください' });
      }

      const dataRoot = path.resolve(config.mcDataRoot, server.mcId);
      const fullPath = path.resolve(dataRoot, parsed.data.jarPath);
      if (fullPath !== dataRoot && !fullPath.startsWith(dataRoot + path.sep)) {
        return reply.code(400).send({ error: 'invalid jarPath' });
      }
      if (!fullPath.toLowerCase().endsWith('.jar')) {
        return reply.code(400).send({ error: 'jarファイルを指定してください' });
      }
      try {
        await fs.access(fullPath);
      } catch {
        return reply.code(400).send({ error: 'jarファイルが見つかりません' });
      }

      // CUSTOM: 既存コンテナが残っていると次回startで古いImage/設定のまま再利用されてしまうため、
      // 切り替え時に削除しておく(start()がcontainerId未設定なら新しい設定で再作成する)。
      if (server.containerId) {
        try {
          await dockerService.remove(server.containerId);
        } catch (error) {
          const statusCode = (error as { statusCode?: number }).statusCode;
          if (statusCode !== 404) throw error;
        }
      }

      const updated = await mongoService.updateServer(request.params.serverId, request.params.mcId, {
        customJarPath: parsed.data.jarPath,
        containerId: null,
        status: 'CREATED',
      });

      return serializeServer(updated!);
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
        try {
          await dockerService.remove(server.containerId);
        } catch (error) {
          // CUSTOM: コンテナが既に存在しない(404)場合だけは無視して削除を続行する。
          // 以前はここで全エラーを無条件に握りつぶしていたため、Dockerデーモンの
          // 一時的な不調等でコンテナ削除が失敗してもDBレコード・データだけが消え、
          // コンテナだけが取り残されて(RestartPolicy: unless-stoppedにより)
          // CUSTOM_SERVER未設定のまま再起動を繰り返す不具合が実際に発生した。
          // それ以外のエラーは削除全体を失敗させ、コンテナ・データ・DBレコードの
          // 不整合を防ぐ。
          const statusCode = (error as { statusCode?: number }).statusCode;
          if (statusCode !== 404) {
            throw error;
          }
        }
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
      if (server.status === 'PENDING_JAR_SELECTION') {
        return reply.code(409).send({ error: 'Select a jar file before starting this server' });
      }

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
