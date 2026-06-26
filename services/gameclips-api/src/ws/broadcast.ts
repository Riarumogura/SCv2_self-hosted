import { WebSocket } from 'ws';

export type GameClipWsEvent =
  | { type: 'like_updated'; gameClipId: string; likeCount: number }
  | {
      type: 'comment_added';
      gameClipId: string;
      commentCount: number;
      comment: { id: string; body: string; createdBy: string; createdAt: string };
    };

// CUSTOM: gameclips-api専用の軽量Pub/Sub。Stoatコアのevents(Redis)バスには接続せず、
// このプロセス内のメモリ上でサーバーID単位のソケット集合を管理する。
// マルチインスタンス運用にする場合は別途Redis等の共有ストアへの置き換えが必要。
const subscribers = new Map<string, Set<WebSocket>>();

export function subscribe(serverId: string, socket: WebSocket): void {
  const set = subscribers.get(serverId) ?? new Set<WebSocket>();
  set.add(socket);
  subscribers.set(serverId, set);
}

export function unsubscribe(serverId: string, socket: WebSocket): void {
  const set = subscribers.get(serverId);
  if (!set) return;
  set.delete(socket);
  if (set.size === 0) subscribers.delete(serverId);
}

export function broadcast(serverId: string, event: GameClipWsEvent): void {
  const set = subscribers.get(serverId);
  if (!set) return;
  const payload = JSON.stringify(event);
  for (const socket of set) {
    if (socket.readyState === socket.OPEN) {
      socket.send(payload);
    }
  }
}
