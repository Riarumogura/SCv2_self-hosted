import Docker from 'dockerode';
import { PassThrough } from 'stream';
import { config } from '../config';
import { McServer, McServerStatus } from './mongodb.service';

const docker = new Docker({ socketPath: config.dockerSocketPath });

const MC_IMAGE_LATEST = 'itzg/minecraft-server';
// CUSTOM: 手動アップロードされたjar(主にForge 1.7~1.12系の古いModpack)は、
// :latestタグが積んでいる最新Java(java25等)ではLaunchWrapper/AppClassLoaderの
// ClassCastExceptionで起動に失敗する。Forge 1.12.2系はJava 8が必要なため、
// UPLOAD経由のサーバーはjava8タグを使う(実際のユーザーのForge 1.12.2サーバーが
// これで起動できないことを確認して特定した不具合)。
const MC_IMAGE_JAVA8 = 'itzg/minecraft-server:java8';
const GAME_PORT = '25565/tcp';
const RCON_PORT = '25575/tcp';

// CUSTOM: Dockerの実際のコンテナステートを、フロント/DBで使うステータス語彙にマッピングする
function mapDockerStatus(state: string | undefined): McServerStatus {
  switch (state) {
    case 'running':
      return 'RUNNING';
    case 'restarting':
      return 'STARTING';
    case 'removing':
    case 'paused':
    case 'dead':
      return 'ERROR';
    case 'created':
    case 'exited':
      return 'STOPPED';
    default:
      return 'ERROR';
  }
}

export class DockerService {
  async createContainer(server: McServer): Promise<string> {
    // CUSTOM: source==='UPLOAD'はzipから展開済みの既存jarをそのまま起動する。
    // itzgイメージはTYPE=CUSTOM + CUSTOM_SERVER=<既存jarのファイルパス>を渡すと
    // ダウンロードをスキップしてそのjarを起動する(/image/scripts/start-deployCustomの
    // `elif [[ -f ${CUSTOM_SERVER} ]]`分岐で確認済み)。EULA/server.properties/world
    // 関連の処理はTYPE分岐の外側の共通処理なので、CUSTOM時も通常通り機能する。
    const launchEnv =
      server.source === 'UPLOAD'
        ? [`TYPE=CUSTOM`, `CUSTOM_SERVER=/data/${server.customJarPath}`]
        : [`TYPE=${server.type}`, `VERSION=${server.version}`];

    const container = await docker.createContainer({
      name: server.containerName,
      Image: server.source === 'UPLOAD' ? MC_IMAGE_JAVA8 : MC_IMAGE_LATEST,
      Env: [
        'EULA=TRUE',
        ...launchEnv,
        `MEMORY=${server.memory}`,
        'ENABLE_RCON=true',
        `RCON_PASSWORD=${server.rconPassword}`,
        `RCON_PORT=${server.rconPort}`,
      ],
      ExposedPorts: {
        [GAME_PORT]: {},
        [RCON_PORT]: {},
      },
      HostConfig: {
        // CUSTOM: Dockerデーモンから見えるのはホストのパスのみ(Docker-outside-of-Docker)。
        // mc-manager「コンテナ内」のパス(config.mcDataRoot)を渡すと
        // "mounts denied: not shared from the host" になる。config.tsの説明を参照。
        Binds: [`${config.mcDataRootHost}/${server.mcId}:/data`],
        PortBindings: {
          // CUSTOM: ゲームポートのみホストへ公開する。RCONはstoat_defaultネットワーク
          // 経由でmc-managerコンテナ名解決のみ到達可能にし、ホストには公開しない。
          [GAME_PORT]: [{ HostPort: String(server.port) }],
        },
        RestartPolicy: { Name: 'unless-stopped' },
      },
      NetworkingConfig: {
        EndpointsConfig: {
          [config.dockerNetwork]: {},
        },
      },
    });

    return container.id;
  }

  async start(containerId: string): Promise<void> {
    const container = docker.getContainer(containerId);
    await container.start();
  }

  async stop(containerId: string, timeoutSeconds = 10): Promise<void> {
    const container = docker.getContainer(containerId);
    await container.stop({ t: timeoutSeconds });
  }

  async kill(containerId: string): Promise<void> {
    const container = docker.getContainer(containerId);
    await container.kill();
  }

  async remove(containerId: string): Promise<void> {
    const container = docker.getContainer(containerId);
    await container.remove({ force: true });
  }

  async inspectStatus(containerId: string): Promise<McServerStatus> {
    const container = docker.getContainer(containerId);
    try {
      const info = await container.inspect();
      return mapDockerStatus(info.State?.Status);
    } catch (error) {
      // CUSTOM: コンテナが既に存在しない(手動削除など)場合はSTOPPED扱いにする
      return 'STOPPED';
    }
  }

  /**
   * コンテナのログをフォロー(tail -f相当)してテキスト行をストリームする。
   * Docker Engine APIは非TTYコンテナのログをstdout/stderr多重化フレームで返すため、
   * dockerode付属のdemuxStreamで通常のテキストストリームに分離する。
   * 戻り値の関数を呼ぶとストリームを停止できる。
   */
  async streamLogs(containerId: string, onLine: (line: string) => void): Promise<() => void> {
    const container = docker.getContainer(containerId);
    const logStream = await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
      tail: 200,
    });

    const out = new PassThrough();
    const err = new PassThrough();
    docker.modem.demuxStream(logStream, out, err);

    const handleData = (chunk: Buffer) => {
      for (const line of chunk.toString('utf-8').split('\n')) {
        if (line.length > 0) onLine(line);
      }
    };
    out.on('data', handleData);
    err.on('data', handleData);

    // CUSTOM: logs()の型はNodeJS.ReadableStreamだがdestroy()は実体(Readable)には存在する
    const destroyableLogStream = logStream as unknown as { destroy: () => void };

    return () => {
      out.removeListener('data', handleData);
      err.removeListener('data', handleData);
      destroyableLogStream.destroy();
    };
  }
}
