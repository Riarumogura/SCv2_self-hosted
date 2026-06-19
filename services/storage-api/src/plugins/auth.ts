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

// CUSTOM: fp() でラップしないとこのプラグインのデコレータ/フックが
// 自身のカプセル化スコープ内に閉じてしまい、兄弟として登録される
// storageRoutes には適用されず request.user が常に未設定のまま 401 になる。
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

    try {
      // Verify token with Stoat API
      const response = await axios.get(`${config.stoatApiUrl}/users/@me`, {
        headers: {
          'X-Session-Token': token,
        },
      });

      // Extract server ID from request context
      const serverId = request.headers['x-server-id'] as string;
      if (!serverId) {
        return reply.code(400).send({ error: 'Server ID header missing' });
      }

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
      request.user = {
        id: response.data._id,
        username: response.data.username,
        serverId,
        permissions: serverResponse.data.permissions || [],
      };

    } catch (error) {
      console.error('Authentication error:', error);
      return reply.code(401).send({ error: 'Invalid or expired token' });
    }
  });
};

export const authPlugin = fp(authPluginImpl);
