import { Rcon } from 'rcon-client';

export class RconError extends Error {}

// CUSTOM: コネクション再利用はPhase 1では複雑化を避けるため行わず、
// コマンド送信ごとに接続・送信・切断する。host はコンテナ名を渡し、
// mc-managerが同じDockerネットワーク(stoat_default)上にいることで名前解決できる。
export class RconService {
  async sendCommand(host: string, port: number, password: string, command: string): Promise<string> {
    let rcon: Rcon | null = null;
    try {
      rcon = await Rcon.connect({ host, port, password, timeout: 5000 });
      return await rcon.send(command);
    } catch (error) {
      throw new RconError(`RCON command failed: ${(error as Error).message}`);
    } finally {
      await rcon?.end().catch(() => undefined);
    }
  }
}
