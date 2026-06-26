import dotenv from 'dotenv';

dotenv.config();

export const config = {
  // MongoDB Configuration
  mongodb: {
    uri: process.env.MONGODB_URI || 'mongodb://database:27017',
    dbName: process.env.MONGODB_DB_NAME || 'sawarachats',
  },

  // API Configuration
  apiPort: parseInt(process.env.API_PORT || '3000'),
  apiHost: process.env.API_HOST || '0.0.0.0',
  nodeEnv: process.env.NODE_ENV || 'development',

  // Stoat API for authentication
  stoatApiUrl: process.env.STOAT_API_URL || 'http://api:14702',

  // CORS
  corsOrigin: (process.env.CORS_ORIGIN || 'http://local.sawarachats.chat').split(','),
};
