import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { config } from './config';
import { authPlugin } from './plugins/auth';
import { storageRoutes } from './routes/storage';

const fastify = Fastify({
  logger: true,
});

// Register plugins
fastify.register(cors, {
  origin: config.corsOrigin,
  credentials: true,
});

fastify.register(helmet);
fastify.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute',
});

fastify.register(swagger, {
  swagger: {
    info: {
      title: 'SawaraChats Storage API',
      description: 'Online storage API for SawaraChats',
      version: '1.0.0',
    },
    host: config.apiHost,
    schemes: ['http'],
    consumes: ['application/json'],
    produces: ['application/json'],
  },
});

fastify.register(swaggerUi, {
  routePrefix: '/docs',
});

// Register authentication plugin
fastify.register(authPlugin);

// Register routes
fastify.register(storageRoutes, { prefix: '/api/v1/storage' });

// Health check endpoint
fastify.get('/health', async () => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

const start = async () => {
  try {
    await fastify.listen({
      port: config.apiPort,
      host: config.apiHost,
    });
    console.log(`Storage API server listening on ${config.apiHost}:${config.apiPort}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();