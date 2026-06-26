import { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import axios from 'axios';
import { config } from '../config';

export interface AuthenticatedUser {
  id: string;
  username: string;
  serverId: string;
  permissions: string[];
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthenticatedUser | null;
  }
}

// CUSTOM: authPluginは認証フックが通るたびにStoat APIへ2回(@me, members)
// 問い合わせる実装になっており、一覧更新や作成を連続して行うとStoat APIの
// レートリミットにすぐ達してしまう。短時間のインメモリキャッシュで同一トークン+
// サーバーの組み合わせへの問い合わせ頻度を抑える(storage-apiのauth.tsと同じ実装)。
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
// stampRoutesには適用されず request.user が常に未設定のまま 401 になる。
const authPluginImpl: FastifyPluginAsync = async (fastify) => {
  fastify.decorateRequest('user', null);

  fastify.addHook('onRequest', async (request, reply) => {
    // CUSTOM: Stoat(Revolt)のAPIはOAuth系の `Authorization: Bearer` ではなく、
    // 独自の `X-Session-Token` ヘッダーでセッショントークンを受け渡す
    // (stoat.jsのClient#authenticationHeaderも同様)。
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
      // Verify token with Stoat API
      const response = await axios.get(`${config.stoatApiUrl}/users/@me`, {
        headers: {
          'X-Session-Token': token,
        },
      });

      // Check if user is member of the server
      const serverResponse = await axios.get(`${config.stoatApiUrl}/servers/${serverId}/members/${response.data._id}`, {
        headers: {
          'X-Session-Token': token,
        },
      });

      if (!serverResponse.data) {
        return reply.code(403).send({ error: 'User is not a member of this server' });
      }

      // Set user object on request
      const user: AuthenticatedUser = {
        id: response.data._id,
        username: response.data.username,
        serverId,
        permissions: serverResponse.data.permissions || [],
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
