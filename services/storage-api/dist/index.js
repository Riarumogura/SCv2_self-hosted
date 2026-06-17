"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fastify_1 = __importDefault(require("fastify"));
const cors_1 = __importDefault(require("@fastify/cors"));
const helmet_1 = __importDefault(require("@fastify/helmet"));
const rate_limit_1 = __importDefault(require("@fastify/rate-limit"));
const swagger_1 = __importDefault(require("@fastify/swagger"));
const swagger_ui_1 = __importDefault(require("@fastify/swagger-ui"));
const config_1 = require("./config");
const auth_1 = require("./plugins/auth");
const storage_1 = require("./routes/storage");
const fastify = (0, fastify_1.default)({
    logger: true,
});
fastify.register(cors_1.default, {
    origin: config_1.config.corsOrigin,
    credentials: true,
});
fastify.register(helmet_1.default);
fastify.register(rate_limit_1.default, {
    max: 100,
    timeWindow: '1 minute',
});
fastify.register(swagger_1.default, {
    swagger: {
        info: {
            title: 'SawaraChats Storage API',
            description: 'Online storage API for SawaraChats',
            version: '1.0.0',
        },
        host: config_1.config.apiHost,
        schemes: ['http'],
        consumes: ['application/json'],
        produces: ['application/json'],
    },
});
fastify.register(swagger_ui_1.default, {
    routePrefix: '/docs',
});
fastify.register(auth_1.authPlugin);
fastify.register(storage_1.storageRoutes, { prefix: '/api/v1/storage' });
fastify.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
});
const start = async () => {
    try {
        await fastify.listen({
            port: config_1.config.apiPort,
            host: config_1.config.apiHost,
        });
        console.log(`Storage API server listening on ${config_1.config.apiHost}:${config_1.config.apiPort}`);
    }
    catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};
start();
//# sourceMappingURL=index.js.map