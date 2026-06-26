import { FastifyPluginAsync } from 'fastify';
import { authenticateUser, AuthError } from '../plugins/auth';
import { subscribe, unsubscribe } from '../ws/broadcast';

// CUSTOM: ブラウザのWebSocketはカスタムヘッダーを送れないため、X-Session-Tokenは
// クエリパラメータ(?token=...)で受け取る。通常のHTTPルートが使うauthPluginの
// onRequestフック(ヘッダー前提)はこのルートには適用しない(index.tsでの登録位置を分離)。
export const gameClipsSocketRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Params: { serverId: string }; Querystring: { token?: string } }>(
    '/servers/:serverId/socket',
    { websocket: true },
    async (socket, request) => {
      const { serverId } = request.params;
      const token = request.query.token;

      if (!token) {
        socket.close(1008, 'token query parameter missing');
        return;
      }

      try {
        await authenticateUser(token, serverId);
      } catch (error) {
        const code = error instanceof AuthError ? error.statusCode : 401;
        socket.close(1008, `Forbidden (${code})`);
        return;
      }

      subscribe(serverId, socket);
      socket.on('close', () => unsubscribe(serverId, socket));
    },
  );
};
