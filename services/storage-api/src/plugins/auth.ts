import { FastifyPluginAsync } from 'fastify';
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

export const authPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.decorateRequest('user', null);

  fastify.addHook('onRequest', async (request, reply) => {
    const authHeader = request.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Authorization header missing or invalid' });
    }

    const token = authHeader.substring(7);

    try {
      // Verify token with Stoat API
      const response = await axios.get(`${config.stoatApiUrl}/users/@me`, {
        headers: {
          'Authorization': `Bearer ${token}`,
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
          'Authorization': `Bearer ${token}`,
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
