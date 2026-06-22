import { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import axios from 'axios';
import { config } from '../config';
import { calculateServerPermission, isServerAdmin, StoatServer, StoatMember } from '../permissions';

export interface AuthenticatedUser {
  id: string;
  username: string;
  serverId: string;
  isAdmin: boolean;
  permissionBitfield: bigint;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthenticatedUser | null;
  }
}

// CUSTOM: calendar-api/storage-api の auth.ts は
// `serverResponse.data.permissions` という存在しないフィールドを読んでいた
// (Stoat の Member API は roles: string[] しか返さず、permissionsは
// クライアントSDKが Server.default_permissions + ロールのallow/denyから
// 計算する)。mc-managerでは Server も取得し、permissions.ts の
// calculateServerPermission()で同じアルゴリズムをサーバーサイドで再現する。
const AUTH_CACHE_TTL_MS = 30_000;
const authCache = new Map<string, { user: AuthenticatedUser; expiresAt: number }>();

function getCachedUser(cacheKey: string): AuthenticatedUser | undefined {
  const entry = authCache.get(cacheKey);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    authCache.delete(cacheKey);
    return undefined;
  }
  return entry.user;
}

function setCachedUser(cacheKey: string, user: AuthenticatedUser): void {
  authCache.set(cacheKey, { user, expiresAt: Date.now() + AUTH_CACHE_TTL_MS });
}

// CUSTOM: fp() でラップしないとこのプラグインのデコレータ/フックが
// 自身のカプセル化スコープ内に閉じてしまい、兄弟として登録される
// minecraftRoutes には適用されず request.user が常に未設定のまま 401 になる。
const authPluginImpl: FastifyPluginAsync = async (fastify) => {
  fastify.decorateRequest('user', null);

  fastify.addHook('onRequest', async (request, reply) => {
    // CUSTOM: Stoat(Revolt)のAPIは `X-Session-Token` ヘッダーでセッショントークンを
    // 受け渡す(storage-api/calendar-apiのauthPluginおよびstoat.jsのClient#authenticationHeaderと同様)。
    const token = request.headers['x-session-token'] as string | undefined;

    if (!token) {
      return reply.code(401).send({ error: 'X-Session-Token header missing or invalid' });
    }

    const serverId = request.headers['x-server-id'] as string;
    if (!serverId) {
      return reply.code(400).send({ error: 'Server ID header missing' });
    }

    const cacheKey = `${token}:${serverId}`;
    const cached = getCachedUser(cacheKey);
    if (cached) {
      request.user = cached;
      return;
    }

    try {
      const meResponse = await axios.get(`${config.stoatApiUrl}/users/@me`, {
        headers: { 'X-Session-Token': token },
      });
      const userId: string = meResponse.data._id;

      const [serverResponse, memberResponse] = await Promise.all([
        axios.get<StoatServer>(`${config.stoatApiUrl}/servers/${serverId}`, {
          headers: { 'X-Session-Token': token },
        }),
        axios.get<{ member?: StoatMember } & StoatMember>(
          `${config.stoatApiUrl}/servers/${serverId}/members/${userId}`,
          { headers: { 'X-Session-Token': token } },
        ),
      ]);

      const server = serverResponse.data;
      // CUSTOM: MemberResponse は Member 単体、または {member, roles} の
      // どちらの形でも返ってくる(OpenAPI上 anyOf)。memberフィールドの有無で判別する。
      const member: StoatMember = memberResponse.data.member ?? memberResponse.data;

      const permissionBitfield = calculateServerPermission(server, member);
      const admin = isServerAdmin(server, member, userId);

      const user: AuthenticatedUser = {
        id: userId,
        username: meResponse.data.username,
        serverId,
        isAdmin: admin,
        permissionBitfield,
      };

      request.user = user;
      setCachedUser(cacheKey, user);
    } catch (error) {
      if (axios.isAxiosError(error) && error.response) {
        console.error('Authentication error:', error.response.status, error.response.data);
        if (error.response.status === 429) {
          return reply.code(429).send({ error: 'Rate limited by Stoat API, please retry shortly' });
        }
        if (error.response.status === 404) {
          return reply.code(403).send({ error: 'User is not a member of this server' });
        }
      } else {
        console.error('Authentication error:', error);
      }
      return reply.code(401).send({ error: 'Invalid or expired token' });
    }
  });
};

export const authPlugin = fp(authPluginImpl);

export function requireAdmin(request: { user: AuthenticatedUser | null }): boolean {
  return Boolean(request.user?.isAdmin);
}
