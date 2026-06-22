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
  corsOrigin: (process.env.CORS_ORIGIN || 'http://local.sawarachats.chat')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),

  // Minecraft server data + Docker integration
  // CUSTOM: mc-managerはDocker-outside-of-Docker構成(ホストのdocker.sockをマウントして
  // 自分自身もdockerodeでホストデーモンに発注する側)のため、パスを2種類使い分ける必要がある。
  // - mcDataRoot: mc-managerコンテナ「内部」から見たパス。fs.mkdir/fs.rm等、mc-manager自身の
  //   Node.jsプロセスがファイル操作する際はこちらを使う(bind mountにより/data/minecraftとして見える)。
  // - mcDataRootHost: Dockerデーモンから見た「ホスト実パス」。dockerode経由で動的に作る
  //   MCサーバーコンテナのBindsには必ずこちらを使う。デーモンはmc-managerコンテナの中身を
  //   知らず、ホストのパスとしてしか解釈できないため、内部パスを渡すと
  //   "mounts denied: ... is not shared from the host" エラーになる。
  mcDataRoot: process.env.MC_DATA_ROOT || '/data/minecraft',
  mcDataRootHost: process.env.MC_DATA_ROOT_HOST || '/data/minecraft',
  dockerSocketPath: process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock',
  dockerNetwork: process.env.DOCKER_NETWORK || 'stoat_default',
};
