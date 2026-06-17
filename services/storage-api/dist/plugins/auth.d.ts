import { FastifyPluginAsync } from 'fastify';
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
export declare const authPlugin: FastifyPluginAsync;
//# sourceMappingURL=auth.d.ts.map