"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.authPlugin = void 0;
const axios_1 = __importDefault(require("axios"));
const config_1 = require("../config");
const authPlugin = async (fastify) => {
    fastify.decorateRequest('user', null);
    fastify.addHook('onRequest', async (request, reply) => {
        const authHeader = request.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return reply.code(401).send({ error: 'Authorization header missing or invalid' });
        }
        const token = authHeader.substring(7);
        try {
            const response = await axios_1.default.get(`${config_1.config.stoatApiUrl}/users/@me`, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                },
            });
            const serverId = request.headers['x-server-id'];
            if (!serverId) {
                return reply.code(400).send({ error: 'Server ID header missing' });
            }
            const serverResponse = await axios_1.default.get(`${config_1.config.stoatApiUrl}/servers/${serverId}/members/${response.data._id}`, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                },
            });
            if (!serverResponse.data) {
                return reply.code(403).send({ error: 'User is not a member of this server' });
            }
            request.user = {
                id: response.data._id,
                username: response.data.username,
                serverId,
                permissions: serverResponse.data.permissions || [],
            };
        }
        catch (error) {
            console.error('Authentication error:', error);
            return reply.code(401).send({ error: 'Invalid or expired token' });
        }
    });
};
exports.authPlugin = authPlugin;
//# sourceMappingURL=auth.js.map