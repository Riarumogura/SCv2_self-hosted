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

export class AuthError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

// CUSTOM: storage-api/src/plugins/auth.ts と同じ認証方式・キャッシュ戦略を採用。
// Stoat APIへの問い合わせ頻度を抑えるための短時間インメモリキャッシュ。
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

// CUSTOM: HTTPのonRequestフック(ヘッダー認証)とWebSocketルート(クエリパラメータ認証、
// ブラウザのWebSocketはカスタムヘッダーを送れないため)の両方から呼べるよう、
// 認証処理本体をここに切り出す。
export async function authenticateUser(token: string, serverId: string): Promise<AuthenticatedUser> {
  const cacheKey = `${token}:${serverId}`;
  const cached = getCachedUser(cacheKey);
  if (cached) return cached;

  try {
    const response = await axios.get(`${config.stoatApiUrl}/users/@me`, {
      headers: { 'X-Session-Token': token },
    });

    const serverResponse = await axios.get(
      `${config.stoatApiUrl}/servers/${serverId}/members/${response.data._id}`,
      { headers: { 'X-Session-Token': token } },
    );

    if (!serverResponse.data) {
      throw new AuthError(403, 'User is not a member of this server');
    }

    const user: AuthenticatedUser = {
      id: response.data._id,
      username: response.data.username,
      serverId,
      permissions: serverResponse.data.permissions || [],
    };

    setCachedUser(cacheKey, user);
    return user;
  } catch (error) {
    if (error instanceof AuthError) throw error;
    if (axios.isAxiosError(error) && error.response) {
      console.error('Authentication error:', error.response.status, error.response.data);
      if (error.response.status === 429) {
        throw new AuthError(429, 'Rate limited by Stoat API, please retry shortly');
      }
      if (error.response.status === 404) {
        throw new AuthError(403, 'User is not a member of this server');
      }
    } else {
      console.error('Authentication error:', error);
    }
    throw new AuthError(401, 'Invalid or expired token');
  }
}

// CUSTOM: fp() でラップしないとこのプラグインのデコレータ/フックが
// 自身のカプセル化スコープ内に閉じてしまい、兄弟として登録される
// gameclipsRoutes には適用されず request.user が常に未設定のまま 401 になる。
const authPluginImpl: FastifyPluginAsync = async (fastify) => {
  fastify.decorateRequest('user', null);

  fastify.addHook('onRequest', async (request, reply) => {
    // CUSTOM: Stoat(Revolt)のAPIは `X-Session-Token` ヘッダーでセッショントークンを
    // 受け渡す(storage-apiのauthPluginおよびstoat.jsのClient#authenticationHeaderと同様)。
    const token = request.headers['x-session-token'] as string | undefined;

    if (!token) {
      return reply.code(401).send({ error: 'X-Session-Token header missing or invalid' });
    }

    const serverId = request.headers['x-server-id'] as string;
    if (!serverId) {
      return reply.code(400).send({ error: 'Server ID header missing' });
    }

    try {
      request.user = await authenticateUser(token, serverId);
    } catch (error) {
      if (error instanceof AuthError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });
};

export const authPlugin = fp(authPluginImpl);
