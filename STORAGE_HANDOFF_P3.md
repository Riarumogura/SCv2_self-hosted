# SawaraChats オンラインストレージ機能 フェーズ2引き継ぎドキュメント

## 1. フェーズ1・2で実装した内容

### 作成・変更したファイルの絶対パス一覧

#### フェーズ1（既存からの継続）
1. `/Users/wakisakahayato/GitHub/SawaraChats_v2/SCv2_self-hosted/services/storage-api/package.json`
2. `/Users/wakisakahayato/GitHub/SawaraChats_v2/SCv2_self-hosted/services/storage-api/tsconfig.json`
3. `/Users/wakisakahayato/GitHub/SawaraChats_v2/SCv2_self-hosted/services/storage-api/Dockerfile`
4. `/Users/wakisakahayato/GitHub/SawaraChats_v2/SCv2_self-hosted/services/storage-api/.env.example`
5. `/Users/wakisakahayato/GitHub/SawaraChats_v2/SCv2_self-hosted/services/storage-api/src/config.ts`
6. `/Users/wakisakahayato/GitHub/SawaraChats_v2/SCv2_self-hosted/services/storage-api/src/index.ts`
7. `/Users/wakisakahayato/GitHub/SawaraChats_v2/SCv2_self-hosted/services/storage-api/src/plugins/auth.ts`
8. `/Users/wakisakahayato/GitHub/SawaraChats_v2/SCv2_self-hosted/services/storage-api/src/services/minio.service.ts`
9. `/Users/wakisakahayato/GitHub/SawaraChats_v2/SCv2_self-hosted/services/storage-api/src/services/mongodb.service.ts`
10. `/Users/wakisakahayato/GitHub/SawaraChats_v2/SCv2_self-hosted/services/storage-api/src/routes/storage.ts`
11. `/Users/wakisakahayato/GitHub/SawaraChats_v2/SCv2_self-hosted/compose.yml`

#### フェーズ2（今回実装）
12. `/Users/wakisakahayato/GitHub/SawaraChats_v2/SCv2_self-hosted/Caddyfile` - storage-apiリバースプロキシ設定追加
13. `/Users/wakisakahayato/GitHub/SawaraChats_v2/SCv2_for-web/packages/client/src/api/storage.ts` - APIクライアント実装
14. `/Users/wakisakahayato/GitHub/SawaraChats_v2/SCv2_for-web/packages/client/src/interface/navigation/channels/ServerSidebar.tsx` - ストレージメニュー追加
15. `/Users/wakisakahayato/GitHub/SawaraChats_v2/SCv2_for-web/packages/client/src/interface/channels/text/TextChannel.tsx` - sidebarState拡張
16. `/Users/wakisakahayato/GitHub/SawaraChats_v2/SCv2_for-web/packages/client/components/modal/modals/CreateStorage.tsx` - ストレージ作成モーダル
17. `/Users/wakisakahayato/GitHub/SawaraChats_v2/SCv2_for-web/packages/client/components/app/menus/MessageContextMenu.tsx` - ファイル保存機能追加

### 各ファイルの役割（フェーズ2追加分）
- **Caddyfile**: storage-apiへのリバースプロキシ設定（`/storage*` → `http://storage-api:3001`）
- **storage.ts**: フロントエンドからストレージAPIにアクセスするためのTypeScriptクライアント
- **ServerSidebar.tsx**: サーバーサイドバー下部に固定ストレージメニューを追加
- **TextChannel.tsx**: sidebarStateに`storage`状態を追加し、エクスプローラーUIの枠組みを作成
- **CreateStorage.tsx**: 新しいストレージを作成するモーダルコンポーネント
- **MessageContextMenu.tsx**: ファイルの右クリックメニューに「ストレージに保存」機能を追加

## 2. 確定済みの設計方針

### MinIOバケット戦略
- **revolt-uploads**: チャット専用（Stoat既存・変更しない）
- **revolt-storage**: オンラインストレージ専用（新規作成）

### フォルダ構造
```
revolt-storage/
└── server_{serverID}/
    └── storage_{storageID}/
        └── (ファイル・フォルダ)
```

### 認証方式
- フロントエンドからstorage-apiへのリクエストに `Authorization: Bearer {stoatのセッショントークン}` を付与
- storage-apiがStoatのAPIにトークン検証リクエストを送って認証
- Stoatの既存認証コードは変更しない

### APIエンドポイント構成
- `POST /api/v1/storage` - ストレージ作成
- `GET /api/v1/storage` - ストレージ一覧取得
- `GET /api/v1/storage/{storageId}` - ストレージ詳細取得
- `PATCH /api/v1/storage/{storageId}` - ストレージ更新
- `DELETE /api/v1/storage/{storageId}` - ストレージ削除
- `GET /api/v1/storage/server/limits` - サーバー容量制限取得

### MongoDB コレクション構造
- **storage_configs**: ストレージ定義（名前・上限・サーバーID）
- **storage_usage**: 使用量キャッシュ

## 3. 実装済みファイルの内容を全文記載

### Caddyfile（変更箇所のみ）
```caddy
http://local.sawarachats.chat {
    # ... 既存のルート ...

    route /storage* {
        uri strip_prefix /storage
        reverse_proxy http://storage-api:3001 {
            header_down Location "^/" "/storage/"
        }
    }

    reverse_proxy http://web:5000
}
```

### SCv2_for-web/packages/client/src/api/storage.ts
```typescript
// CUSTOM: オンラインストレージAPIクライアント
import env from "@revolt/common/lib/env";
import { useClient } from "@revolt/client";

export interface StorageConfig {
  id: string;
  name: string;
  sizeLimit: number;
  usedSize: number;
  fileCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface StorageFile {
  id: string;
  name: string;
  path: string;
  size: number;
  type: string;
  lastModified: string;
}

export interface CreateStorageRequest {
  name: string;
  sizeLimit: number;
}

/**
 * ストレージAPIクライアント
 */
export class StorageApiClient {
  private baseUrl: string;
  
  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || env.DEFAULT_STORAGE_API_URL;
  }

  /**
   * 認証ヘッダーを取得
   */
  private async getAuthHeaders(): Promise<HeadersInit> {
    const client = useClient();
    const currentClient = client();
    
    if (!currentClient) {
      throw new Error("クライアントが取得できません");
    }

    // CUSTOM: stoat.jsのauthenticationHeaderを使用
    const authHeader = currentClient.authenticationHeader;
    if (!authHeader) {
      throw new Error("認証ヘッダーが取得できません");
    }

    return {
      [authHeader[0]]: authHeader[1],
      "Content-Type": "application/json",
    };
  }

  /**
   * サーバーのストレージ一覧を取得
   */
  async getStorages(serverId: string): Promise<StorageConfig[]> {
    const headers = await this.getAuthHeaders();
    const response = await fetch(`${this.baseUrl}/servers/${serverId}/storages`, {
      method: "GET",
      headers,
    });

    if (!response.ok) {
      throw new Error(`ストレージ一覧の取得に失敗しました: ${response.status}`);
    }

    return response.json();
  }

  /**
   * ストレージを作成
   */
  async createStorage(serverId: string, data: CreateStorageRequest): Promise<StorageConfig> {
    const headers = await this.getAuthHeaders();
    const response = await fetch(`${this.baseUrl}/servers/${serverId}/storages`, {
      method: "POST",
      headers,
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      throw new Error(`ストレージの作成に失敗しました: ${response.status}`);
    }

    return response.json();
  }

  /**
   * ストレージの詳細を取得
   */
  async getStorage(serverId: string, storageId: string): Promise<StorageConfig> {
    const headers = await this.getAuthHeaders();
    const response = await fetch(`${this.baseUrl}/servers/${serverId}/storages/${storageId}`, {
      method: "GET",
      headers,
    });

    if (!response.ok) {
      throw new Error(`ストレージの取得に失敗しました: ${response.status}`);
    }

    return response.json();
  }

  /**
   * ストレージ内のファイル一覧を取得
   */
  async listFiles(serverId: string, storageId: string, path?: string): Promise<StorageFile[]> {
    const headers = await this.getAuthHeaders();
    const url = new URL(`${this.baseUrl}/servers/${serverId}/storages/${storageId}/files`);
    
    if (path) {
      url.searchParams.set("path", path);
    }

    const response = await fetch(url.toString(), {
      method: "GET",
      headers,
    });

    if (!response.ok) {
      throw new Error(`ファイル一覧の取得に失敗しました: ${response.status}`);
    }

    return response.json();
  }

  /**
   * ファイルをアップロード
   */
  async uploadFile(
    serverId: string,
    storageId: string,
    file: File,
    path: string
  ): Promise<StorageFile> {
    const headers = await this.getAuthHeaders();
    const formData = new FormData();
    formData.append("file", file);
    formData.append("path", path);

    // Content-Typeを削除（FormDataが自動設定）
    const { "Content-Type": _, ...restHeaders } = headers as Record<string, string>;

    const response = await fetch(
      `${this.baseUrl}/servers/${serverId}/storages/${storageId}/files`,
      {
        method: "POST",
        headers: restHeaders,
        body: formData,
      }
    );

    if (!response.ok) {
      throw new Error(`ファイルのアップロードに失敗しました: ${response.status}`);
    }

    return response.json();
  }

  /**
   * チャットのファイルをストレージに保存
   */
  async saveToStorage(
    serverId: string,
    storageId: string,
    fileUrl: string,
    destinationPath: string
  ): Promise<StorageFile> {
    const headers = await this.getAuthHeaders();
    const response = await fetch(
      `${this.baseUrl}/servers/${serverId}/storages/${storageId}/files/copy`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          sourceUrl: fileUrl,
          destinationPath,
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`ファイルの保存に失敗しました: ${response.status}`);
    }

    return response.json();
  }

  /**
   * ファイルを削除
   */
  async deleteFile(serverId: string, storageId: string, filePath: string): Promise<void> {
    const headers = await this.getAuthHeaders();
    const response = await fetch(
      `${this.baseUrl}/servers/${serverId}/storages/${storageId}/files`,
      {
        method: "DELETE",
        headers,
        body: JSON.stringify({ path: filePath }),
      }
    );

    if (!response.ok) {
      throw new Error(`ファイルの削除に失敗しました: ${response.status}`);
    }
  }

  /**
   * フォルダを作成
   */
  async createFolder(serverId: string, storageId: string, path: string): Promise<void> {
    const headers = await this.getAuthHeaders();
    const response = await fetch(
      `${this.baseUrl}/servers/${serverId}/storages/${storageId}/folders`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ path }),
      }
    );

    if (!response.ok) {
      throw new Error(`フォルダの作成に失敗しました: ${response.status}`);
    }
  }
}

/**
 * ストレージAPIクライアントのインスタンスを作成
 */
export function useStorageApi(): StorageApiClient {
  return new StorageApiClient();
}
```

### SCv2_for-web/packages/client/src/interface/navigation/channels/ServerSidebar.tsx（変更箇所のみ）
```typescript
// CUSTOM: ストレージメニューを追加
const [storages, setStorages] = createSignal<any[]>([]);
const [loading, setLoading] = createSignal(false);

// ストレージ作成モーダルを開く
const openCreateStorageModal = () => {
  openModal({
    type: "create_storage",
    serverId: props.server.id,
  });
};

// レンダリング部（チャンネル一覧の後）
<Draggable
  dragHandles
  type="category"
  disabled={noOrdering()}
  items={props.server.orderedChannels}
  onChange={(ids) => handleOrdering({ type: "categories", ids })}
>
  {/* ... 既存のカテゴリー表示 ... */}
</Draggable>

{/* CUSTOM: ストレージメニューセクション */}
<StorageSection>
  <StorageHeader>
    <Row align="center" gap="sm">
      <MdStorage {...iconSize(16)} />
      <span style={{ fontWeight: "bold" }}>ストレージ</span>
    </Row>
    <IconButton
      size="xs"
      variant="standard"
      onPress={openCreateStorageModal}
      title="新しいストレージを作成"
    >
      <Symbol size={16}>add</Symbol>
    </IconButton>
  </StorageHeader>

  <Show
    when={storages().length > 0}
    fallback={
      <StorageEmptyState>
        <div style={{ textAlign: "center", padding: "var(--gap-md)" }}>
          <MdStorage {...iconSize(32)} style={{ opacity: 0.5 }} />
          <p style={{ marginTop: "var(--gap-sm)", fontSize: "12px" }}>
            ストレージがありません
          </p>
          <button
            onClick={openCreateStorageModal}
            style={{
              marginTop: "var(--gap-sm)",
              padding: "var(--gap-xs) var(--gap-sm)",
              background: "var(--md-sys-color-primary)",
              color: "white",
              border: "none",
              borderRadius: "var(--borderRadius-sm)",
              cursor: "pointer",
            }}
          >
            作成する
          </button>
        </div>
      </StorageEmptyState>
    }
  >
    <StorageList>
      {storages().map((storage) => (
        <StorageItem
          onClick={() => {
            // TODO: ストレージエクスプローラーを開く
            console.log("Open storage:", storage.id);
          }}
        >
          <Row align="center" gap="sm">
            <Symbol size={16}>folder</Symbol>
            <OverflowingText style={{ fontSize: "13px" }}>
              {storage.name}
            </OverflowingText>
          </Row>
          <StorageUsage>
            <div
              style={{
                width: `${(storage.usedSize / storage.sizeLimit) * 100}%`,
                height: "2px",
                background: "var(--md-sys-color-primary)",
                borderRadius: "1px",
              }}
            />
          </StorageUsage>
        </StorageItem>
      ))}
    </StorageList>
  </Show>
</StorageSection>
```

### SCv2_for-web/packages/client/src/interface/channels/text/TextChannel.tsx（変更箇所のみ）
```typescript
/**
 * State of the channel sidebar
 */
export type SidebarState =
  | {
      state: "search";
      query: string;
    }
  | {
      state: "pins";
    }
  | {
      state: "storage";
      storageId: string;
    }
  | {
      state: "default";
    };

// Sidebar state
const [sidebarState, setSidebarState] = createSignal<SidebarState>({
  state: "default",
});

// レンダリング部（Switch文内）
<Match when={sidebarState().state === "storage"}>
  <WideSidebarContainer>
    <SidebarTitle>
      <Text class="label" size="large">
        ストレージエクスプローラー
      </Text>
    </SidebarTitle>
    {/* CUSTOM: ストレージエクスプローラーコンポーネントをここに追加 */}
    <div style={{ padding: "var(--gap-md)" }}>
      ストレージID: {(sidebarState() as { storageId: string }).storageId}
    </div>
  </WideSidebarContainer>
</Match>
```

### SCv2_for-web/packages/client/components/modal/modals/CreateStorage.tsx（全文）
```typescript
// CUSTOM: ストレージ作成モーダル
import { createFormControl, createFormGroup } from "solid-forms";
import { Show } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";

import { Column, Dialog, DialogProps, Form2 } from "@revolt/ui";

import { useModals } from "..";
import { Modals } from "../types";
import { useStorageApi } from "../../../src/api/storage";

/**
 * Modal to create a new storage
 */
export function CreateStorageModal(
  props: DialogProps & Modals & { type: "create_storage" },
) {
  const { t } = useLingui();
  const { showError } = useModals();
  const storageApi = useStorageApi();

  const group = createFormGroup({
    name: createFormControl("", { required: true }),
    sizeLimit: createFormControl("256", { required: true }),
  });

  async function onSubmit() {
    try {
      await storageApi.createStorage(props.serverId, {
        name: group.controls.name.value,
        sizeLimit: parseInt(group.controls.sizeLimit.value) * 1024 * 1024 * 1024, // GB to bytes
      });

      props.onClose();
    } catch (error) {
      showError(error);
    }
  }

  const submit = Form2.useSubmitHandler(group, onSubmit);

  return (
    <Dialog
      show={props.show}
      onClose={props.onClose}
      title={<Trans>Create Storage</Trans>}
      actions={[
        { text: <Trans>Close</Trans> },
        {
          text: <Trans>Create</Trans>,
          onClick: () => {
            onSubmit();
            return false;
          },
          isDisabled: !Form2.canSubmit(group),
        },
      ]}
      isDisabled={group.isPending}
    >
      <form onSubmit={submit}>
        <Column>
          <Form2.TextField
            minlength={1}
            maxlength={50}
            counter
            name="name"
            control={group.controls.name}
            label={t`Storage Name`}
            placeholder={t`e.g. Project Files`}
          />

          <Form2.TextField
            type="number"
            min={1}
            max={1024}
            name="sizeLimit"
            control={group.controls.sizeLimit}
            label={t`Size Limit (GB)`}
          />

          <Show when={group.controls.sizeLimit.value}>
            <div style={{ "font-size": "12px", color: "var(--md-sys-color-on-surface-variant)" }}>
              <Trans>Server-wide capacity limit: 256 GB (configurable)</Trans>
            </div>
          </Show>

          <div style={{ "margin-top": "var(--gap-md)", "font-size": "12px", color: "var(--md-sys-color-on-surface-variant)" }}>
            <div><Trans>• Storage name cannot be changed after creation</Trans></div>
            <div><Trans>• Size limit can be changed later</Trans></div>
            <div><Trans>• Files in storage are accessible to all server members</Trans></div>
          </div>
        </Column>
      </form>
    </Dialog>
  );
}
```

### SCv2_for-web/packages/client/components/app/menus/MessageContextMenu.tsx（変更箇所のみ）
```typescript
// CUSTOM: ストレージ選択モーダル用のインポート
import { useStorageApi } from "../../../src/api/storage";

// CUSTOM: ストレージ選択状態
const [storages, setStorages] = createSignal<any[]>([]);
const [loading, setLoading] = createSignal(false);

/**
 * CUSTOM: ファイルをストレージに保存
 */
async function saveToStorage(storageId: string) {
  if (!props.file || !props.message?.serverId) return;

  try {
    setLoading(true);
    await storageApi.saveToStorage(
      props.message.serverId,
      storageId,
      props.file.originalUrl,
      `chat_${props.message.id}_${props.file.filename}`
    );
    // TODO: 成功通知を表示
  } catch (error) {
    showError(error);
  } finally {
    setLoading(false);
  }
}

/**
 * CUSTOM: ストレージ一覧を取得
 */
async function loadStorages() {
  if (!props.message?.serverId) return;

  try {
    setLoading(true);
    const serverStorages = await storageApi.getStorages(props.message.serverId);
    setStorages(serverStorages);
  } catch (error) {
    showError(error);
  } finally {
    setLoading(false);
  }
}

// レンダリング部（ファイルメニューの後）
{/* CUSTOM: ストレージに保存メニュー */}
<Show when={props.message?.serverId}>
  <ContextMenuDivider />
  <ContextMenuSubMenu
    icon={MdStorage}
    onClick={loadStorages}
    buttonContent={<Trans>Save to Storage</Trans>}
  >
    <Show
      when={storages().length > 0}
      fallback={
        <ContextMenuButton disabled={loading()}>
          <Trans>Loading storages...</Trans>
        </ContextMenuButton>
      }
    >
      <For each={storages()}>
        {(storage) => (
          <ContextMenuButton
            onClick={() => saveToStorage(storage.id)}
            disabled={loading()}
          >
            <div style={{ display: "flex", "justify-content": "space-between", width: "100%" }}>
              <span>{storage.name}</span>
              <span style={{ "font-size": "11px", opacity: 0.7 }}>
                {Math.round(storage.usedSize / 1024 / 1024 / 1024)}/{Math.round(storage.sizeLimit / 1024 / 1024 / 1024)} GB
              </span>
            </div>
          </ContextMenuButton>
        )}
      </For>
    </Show>
  </ContextMenuSubMenu>
</Show>
```

## 4. 次のチャットで実装するタスク

タスク: エクスプローラーUIの詳細実装とファイル操作機能

以下を実装すること:
.### 実装内容
1. **フォルダ作成・移動・削除・名前変更** - フォルダ操作基本機能
2. **ファイルアップロード (ドラッグ&ドロップ対応)** - D&D対応アップロード機能
3. **ファイルダウンロード** - ファイル保存機能
4. **ファイル・フォルダ一覧表示 (アイコン・名前・サイズ・更新日時)** - 詳細リスト表示
5. **画像・動画・PDF・テキストのインラインプレビュー** - プレビュー機能
6. **パンくずリスト (フォルダ階層表示)** - 階層ナビゲーション
7. **検索バー** - ファイル検索機能
8. **容量表示バー (使用量/上限)** - ストレージ容量表示
9. **フォルダ選択ダイアログ (右クリック「ストレージに保存」用)** - 保存先選択UI

## 5. 次のチャットで使う引き継ぎプロンプト

---
# SawaraChats オンラインストレージ フェーズ3引き継ぎ

## フェーズ1・2で完了した作業
- services/storage-api/ のNode.js + TypeScript + Fastifyバックエンド実装
- compose.ymlにサービス追加とcreatebuckets修正
- MinIOバケット戦略確立（revolt-uploads / revolt-storage 分離）
- 認証システム実装（Stoat APIトークン連携）
- 容量管理DB設計実装（MongoDBコレクション: storage_configs / storage_usage）
- Caddyfileにstorage-apiリバースプロキシ設定追加
- フロントエンド環境変数設定追加
- モーダル型定義ファイル拡張（create_storage追加）
- APIクライアント実装（storage.ts）
- ServerSidebar.tsxにストレージメニュー追加
- TextChannel.tsxのsidebarState拡張（storage状態追加）
- ストレージ作成モーダルコンポーネント実装
- MessageContextMenu.tsx拡張（「ストレージに保存」機能追加）

## 環境情報
- self-hosted Fork: /Users/wakisakahayato/GitHub/SawaraChats_v2/SCv2_self-hosted
- for-web Fork: /Users/wakisakahayato/GitHub/SawaraChats_v2/SCv2_for-web
- 開発サーバー: mise run dev → localhost:5173
- storage-api: http://local.sawarachats.chat/storage/api/v1

## 確定済みの設計方針
- MinIOバケット戦略: revolt-uploads（チャット専用） / revolt-storage（ストレージ専用）
- フォルダ構造: server_{serverID}/storage_{storageID}/
- 認証方式: Authorization: Bearer {stoatのセッショントークン}
- 容量管理: MongoDBコレクション（storage_configs / storage_usage）
- サーバーあたり容量上限: 初期値256GB（設定で変更可能）
- APIエンドポイント構成: RESTful設計に準拠

## 最初にやること
以下のファイルを読み込んで現在の状態を把握してから実装を開始すること:
1. `/Users/wakisakahayato/GitHub/SawaraChats_v2/SCv2_for-web/packages/client/src/interface/channels/text/TextChannel.tsx`
2. `/Users/wakisakahayato/GitHub/SawaraChats_v2/SCv2_for-web/packages/client/src/api/storage.ts`
3. `/Users/wakisakahayato/GitHub/SawaraChats_v2/SCv2_for-web/packages/client/src/interface/navigation/channels/ServerSidebar.tsx`

## 今回実装するタスク
エクスプローラーUIの詳細実装とファイル操作機能

### 実装内容
- フォルダ作成・移動・削除・名前変更
- ファイルアップロード (ドラッグ&ドロップ対応)
- ファイルダウンロード
- ファイル・フォルダ一覧表示（アイコン・名前・サイズ・更新日時）
- インラインプレビュー (画像・動画・PDF・テキスト)
- パンくずリスト（フォルダ階層表示）
- 検索バー
- 容量表示バー（使用量/上限）
- フォルダ選択ダイアログ（右クリック「ストレージに保存」用）

### 注意事項
- Phase 1では<Trans>を使わず日本語ハードコードで進める
- 既存のUIコンポーネント (MenuButton・Symbol等) を優先使用
- カスタム追加箇所には // CUSTOM: コメントを付与
---

## 6. 既知の問題・懸念事項

1. **TypeScriptエラー**: ServerSidebar.tsxでCSSプロパティ名のエラー（`fontSize`→`font-size`等）
2. **MessageContextMenu.tsx不完全**: ファイルが不完全に保存され、`Show`タグが閉じられていない
3. **APIエンドポイント不一致**: フロントエンドのAPIクライアントとバックエンドのルートパスが不一致
4. **Message.serverIdプロパティ**: Message型に`serverId`プロパティが存在せず、代わりに`server?.id`を使用する必要
5. **ContextMenuButtonのdisabledプロパティ**: disabled属性が存在せず、`"_disabled"`を使用する必要

## 優先順位
1. MessageContextMenu.tsxの修正（構文エラーとプロパティ修正）
2. エクスプローラーUIコンポーネントの実装
3. ファイル操作APIのバックエンド実装
4. ドラッグ&ドロップ機能の実装
5. プレビュー機能の実装

---

**次のフェーズでは、このドキュメントを参照しながらエクスプローラーUIの詳細実装を開始してください。最初にTextChannel.tsxの分析から始めます。**