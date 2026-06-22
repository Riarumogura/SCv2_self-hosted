// CUSTOM: calendar-api/storage-api の auth.ts は Stoat の Member API レスポンスに
// `permissions: string[]` が直接含まれている前提でコードを書いていたが、実際の
// Stoat REST API (GET /servers/{server}/members/{member}) は `roles: string[]`
// (ロールIDの配列) しか返さず、計算済みのpermissionsフィールドは存在しない。
// 権限はクライアント側のSDK (packages/stoat.js の calculatePermission()) が
// Server.default_permissions と各ロールのallow/deny bitfieldから動的に計算している。
// mc-managerはこのアルゴリズムをサーバーサイドで再実装する(stoat.js本体は依存させない)。

// 今のところ admin判定にしか使わないため、必要な1ビットのみ定義する。
export const Permission = {
  ManageServer: 2n ** 1n,
} as const;

export interface StoatRole {
  permissions: { a: number; d: number };
  rank?: number;
}

export interface StoatServer {
  owner: string;
  default_permissions: number;
  roles?: Record<string, StoatRole>;
}

export interface StoatMember {
  roles?: string[] | null;
}

/**
 * stoat.js の calculatePermission() (Server向け分岐) と同一のアルゴリズム。
 * default_permissions を起点に、メンバーが持つロールを rank の降順
 * (優先度の低い順)に allow/deny を適用していく。オーナー判定は呼び出し側
 * (isServerAdmin)で別途行う(オーナーは個別の権限ビットを持たず常に全権限)。
 */
export function calculateServerPermission(server: StoatServer, member: StoatMember): bigint {
  let perm = BigInt(server.default_permissions ?? 0);

  const roleIds = member.roles ?? [];
  if (roleIds.length > 0 && server.roles) {
    const orderedRoles = roleIds
      .map((id) => server.roles?.[id])
      .filter((role): role is StoatRole => Boolean(role))
      .sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0));

    for (const role of orderedRoles) {
      const allow = BigInt(role.permissions?.a ?? 0);
      const deny = BigInt(role.permissions?.d ?? 0);
      perm = (perm | allow) & ~deny;
    }
  }

  return perm;
}

export function hasPermission(bitfield: bigint, permission: bigint): boolean {
  return (bitfield & permission) === permission;
}

export function isServerAdmin(server: StoatServer, member: StoatMember, userId: string): boolean {
  if (server.owner === userId) return true;
  return hasPermission(calculateServerPermission(server, member), Permission.ManageServer);
}
