# アルバム機能 設計書 / 実装プロンプト

## Context

SawaraChats v2（Stoat/Revolt フォーク）に、サーバー単位で写真・動画を整理できる「アルバム機能」を追加する。既存の「カレンダー機能」（`services/calendar-api` + `CalendarExplorer.tsx`）が、サイドバー下部のボタン → 右側スライドパネル → モーダルでのCRUD という、ほぼ同一のUI/UX・アーキテクチャパターンを持つ既存実装として存在するため、これを下敷きに実装する。

ユーザーとの確認により以下の仕様が確定した:
- スコープ: **サーバー単位**（カレンダーと同様、サーバー内全チャンネルで共有）
- 同日複数アルバム: **無制限**
- 閲覧権限: 編集権限とは別に、**「全員」/「メンバーを選ぶ」の2パターン**
- 編集権限: 仕様通り**「誰でも編集可」/「作成者のみ編集可」/「編集可能メンバーを選ぶ」の3パターン**
- カテゴリ: **誰でも作成可**。検索フォームの+ボタンと、アルバム作成/編集モーダルの+ボタンの両方から作成可能。**複数選択可**。色は**作成時にカラーピッカー（`<input type="color">`、`ServerRoleEditor.tsx`と同じ方式）で手動選択**
- ミニカレンダーの日付色付け: **カテゴリごとの色**を使う（同日に複数カテゴリがあれば複数色を表示）
- 同日複数アルバムの表示: アルバムページ領域に**その日の全アルバムを縦に並べて表示**
- 空欄日付クリック時: 即座に空アルバムを作るのではなく、**作成モーダル（タイトル・閲覧/編集権限・カテゴリ）を開く**
- アルバム削除: **設定（歯車）から削除可能**（確認ダイアログ、写真も同時削除）
- 条件検索: 入力した項目のみAND検索（アルバム名は部分一致、作成日は範囲、カテゴリは複数選択でOR）。未入力項目は無視

写真プレビューは「通常チャットの写真・動画プレビューと同様」という要件があるため、新規ストレージ系(MinIO/storage-api)ではなく、**チャット添付と同じ Autumn (`/attachments`) アップロード経路 + 既存の `image_viewer` モーダル**を再利用する。`File` クラス（`packages/stoat.js/src/classes/File.ts`）は `{_id, tag, metadata, ...}` があれば任意にインスタンス化できるため、album_photo の保存データ（autumnId, tag, metadata）から `File` を組み立てて既存モーダルにそのまま渡せる。

## アーキテクチャ概要（カレンダー機能と1:1対応）

| カレンダー機能 | アルバム機能（新規） |
|---|---|
| `services/calendar-api` | `services/album-api`（新規Fastifyサービス、calendar-apiをコピーして改修） |
| `calendar_events` / `calendar_trade_colors` collections | `albums` / `album_categories` / `album_photos` collections |
| `ServerSidebar.tsx` の `CalendarMenuButton` | 同様の `AlbumMenuButton`（カレンダーボタンの直下に配置） |
| `calendarExplorerSignal.ts` | `albumExplorerSignal.ts`（同パターンでコピー） |
| `TextChannel.tsx` の `SidebarState` `"calendar"` | `"album"` を追加、同様にwidth制御・ResizeHandle |
| `CalendarExplorer.tsx`（FullCalendar使用） | `AlbumExplorer.tsx`（検索フォーム1/4 + アルバムページ3/4） |
| `CreateEvent.tsx`/`EditEvent.tsx`/`DeleteEvent.tsx` | `CreateAlbum.tsx`/`EditAlbum.tsx`/`DeleteAlbum.tsx` |
| `CalendarTradeColorSettings.tsx` | `CreateAlbumCategory.tsx`（カテゴリ作成、色はカラーピッカー） |
| `src/api/calendar.ts` (`CalendarApiClient`) | `src/api/album.ts` (`AlbumApiClient`)、同じ認証ヘッダー構築方式 |
| `env.ts` の `DEFAULT_CALENDAR_API_URL` | `DEFAULT_ALBUM_API_URL`（`VITE_ALBUM_API_URL`／devは`VITE_DEV_ALBUM_API_URL`） |
| Caddyfile `route /calendar*` → `calendar-api:3000` | `route /album*` → `album-api:3000` |
| compose.yml の `calendar-api` サービス定義 | 同パターンで `album-api` サービス追加（ポートは未使用のものを割当、例: 3003） |

---

## 1. バックエンド: `services/album-api`

`services/calendar-api` をコピーして以下に改修する（fastify/cors/helmet/rate-limitのバージョンは `calendar-api/package.json` の現行バージョンをそのまま流用すること。古いhandoff文書のバージョンは使わない）。

### データモデル（MongoDB, db名 `sawarachats`）

```ts
// album_categories
{
  _id: ObjectId,
  serverId: string,
  name: string,
  color: string,       // "#rrggbb" 形式（<input type="color">の値）
  createdBy: string,
  createdAt: Date,
}
// index: { serverId: 1 }

// albums
{
  _id: ObjectId,
  serverId: string,
  date: string,             // "YYYY-MM-DD"。ミニカレンダー検索・条件検索の「作成日時」に使う、
                             // album自体のcreatedAtとは独立した「その日のアルバム」の日付
  title: string,
  categoryIds: string[],    // 複数選択可、album_categories._id文字列
  viewPermission: "anyone" | "members",
  viewMemberIds: string[],  // viewPermission==="members"のとき使用。作成者は常に含む
  editPermission: "anyone" | "creator_only" | "members",
  editMemberIds: string[],  // editPermission==="members"のとき使用。作成者は常に含む
  createdBy: string,
  createdAt: Date,
  updatedAt: Date,
}
// index: { serverId: 1, date: 1 }, { serverId: 1, title: 1 }, { serverId: 1, categoryIds: 1 }

// album_photos
{
  _id: ObjectId,
  albumId: ObjectId,
  serverId: string,          // 権限チェックを跨coll参照なしで高速化するため非正規化
  autumnId: string,          // Autumn /attachments のレスポンスid
  tag: string,                // Autumn bucket tag（"attachments"）
  filename?: string,
  contentType?: string,
  metadata: { type: "Image"|"Video", width: number, height: number } | { type: "File" },
  size?: number,
  uploadedBy: string,
  uploadedAt: Date,
}
// index: { albumId: 1, uploadedAt: 1 }
```

カレンダーの`canEdit()`関数と同じ発想で `canView(album, userId)` / `canEdit(album, userId)` ヘルパーを `routes/album.ts` に実装する:
- `canView`: `viewPermission === "anyone"` または `userId === createdBy` または `viewMemberIds.includes(userId)`
- `canEdit`（写真追加/削除、設定編集、アルバム削除に共通使用）: `userId === createdBy` または (`editPermission === "anyone"`) または (`editPermission === "members"` かつ `editMemberIds.includes(userId)`)
- 編集権限・閲覧権限の値自体の変更は、カレンダーの`editPermission`変更制限と同様に**作成者のみ**許可する（他者が`anyone`に書き換えてロックアウトする事態を防ぐ）

### REST API（`/api/v1` prefix、`X-Session-Token`+`X-Server-Id` 認証は `calendar-api/src/plugins/auth.ts` をそのまま流用）

**カテゴリ:**
- `GET /categories` — サーバー内のカテゴリ一覧
- `POST /categories` — 作成（name, color）。誰でも作成可

**アルバム:**
- `GET /albums?date=YYYY-MM-DD` — 指定日のアルバム一覧（カレンダー検索用。`canView`で絞り込み）
- `GET /albums/dates?from=YYYY-MM-DD&to=YYYY-MM-DD` — ミニカレンダー色付け用。各日付ごとに、その日のアルバムが持つカテゴリ色の集合を返す。例: `[{ date: "2026-06-25", colors: ["#ff0000", "#00ff00"] }]`（`canView`で絞り込み）
- `GET /albums/search?title=&dateFrom=&dateTo=&categoryIds=` — 条件検索（全項目optional、AND結合、titleは部分一致、categoryIdsはOR）
- `POST /albums` — 作成（title, date, categoryIds, viewPermission, viewMemberIds, editPermission, editMemberIds）。作成者は view/editMemberIdsに自動追加
- `GET /albums/:id` — 詳細（`canView`チェック、403）
- `PUT /albums/:id` — 更新（`canEdit`チェック、403。view/editPermission自体の変更は作成者のみ）
- `DELETE /albums/:id` — 削除（`canEdit`チェック、204）。関連する`album_photos`も削除し、Autumn側のファイルも削除する（既存`storage-api`の削除パターンを参考に、ベストエフォートで構わない）

**写真:**
- `GET /albums/:id/photos` — 一覧（`canView`チェック）
- `POST /albums/:id/photos` — 追加（body: `{ autumnId, tag, filename?, contentType?, metadata, size? }` — クライアントが先にAutumnへ直接アップロードし、そのレスポンスをこのエンドポイントに渡す。`canEdit`チェック）
- `DELETE /albums/:id/photos/:photoId` — 個別削除（`canEdit`チェック、204）

### compose.yml / Caddyfile への追加
- `compose.yml`: `calendar-api`の定義（277-292行目）をコピーし、サービス名`album-api`、未使用ポート（例: `3003:3000`）、環境変数は同じ構造（`MONGODB_URI`, `MONGODB_DB_NAME=sawarachats`, `STOAT_API_URL`, `CORS_ORIGIN`）
- `Caddyfile`: `route /calendar*`（72-77行目）と同じ形で `route /album* { uri strip_prefix /album; reverse_proxy http://album-api:3000 { header_down Location "^/" "/album/" } }` を追加
- 新サービスなので独自の`.gitignore`（`node_modules/`, `dist/`, `.env`）を用意する（storage-apiの教訓）

---

## 2. フロントエンド: `SCv2_for-web/packages/client`

### 2.1 サイドバーボタン
`src/interface/navigation/channels/ServerSidebar.tsx` の `CalendarMenuButton`（456-486行目）の直後に、同パターンで `AlbumMenuButton` を追加。歯車アイコンは不要（カテゴリ作成は検索フォーム内+ボタンで行うため）。アイコンは適切なMaterial Symbol（例: `MdPhotoLibrary`または`Symbol`の`photo_library`）。クリックで`requestOpenAlbum({ serverId: props.server.id })`。

### 2.2 シグナル
`src/api/calendarExplorerSignal.ts` を丸ごとコピーして `albumExplorerSignal.ts` を作成（`OpenAlbumRequest`, `pendingAlbumOpen`, `requestOpenAlbum`, `consumePendingAlbumOpen`）。

### 2.3 `TextChannel.tsx` への統合
- `SidebarState` union に `{ state: "album" }` を追加（74行目付近）
- `calendarWidth`と同じ仕組みで `albumWidth`（デフォルト値は「画面右半分程度」という要件から、カレンダーの640pxよりやや広め—実装時に実際の画面幅と相談して決めてよいが、min 360 / max 1000 のレンジはカレンダーと同様の可変にする）。ResizeHandleもカレンダーと同様に流用
- `pendingAlbumOpen`を監視する`createEffect`を追加（231-237行目のカレンダー版と同パターン）
- `Switch`内に`<Match when={sidebarState().state === "album"}>`を追加し、`AlbumExplorer`をマウント（399-427行目のカレンダー版と同パターン、閉じるボタンも同様）

### 2.4 `AlbumExplorer.tsx`（新規、`src/interface/channels/text/`）
レイアウト: 縦flexコンテナ。上1/4 = `AlbumSearchForm`、下3/4 = `AlbumPage`（`flex: 3` / `flex: 1`程度の比率、要件の「1/4程度」を満たせばよい）。

**`AlbumSearchForm`（上部）:**
- 最上部にトグルボタン2つ（「カレンダー検索」/「条件検索」）。選択状態をローカルsignalで管理
- カレンダー検索モード: 軽量な自作ミニカレンダー（`MiniCalendar.tsx`、新規。既存の`CalendarExplorer.tsx`はFullCalendarで重いため流用しない、シンプルな月グリッドを自作）。表示中の月について`GET /albums/dates`を呼び、日付セルの下端などにカテゴリ色のドット（複数色は複数ドット）を表示。日付クリックで`selectedDate` signalをセットし、`AlbumPage`に伝える
- 条件検索モード: アルバム名（テキスト）、作成日（範囲、from/to）、カテゴリ（複数選択チェックボックスリスト、`CreateEvent.tsx`の`MemberPickerList`と同じスタイルパターンを流用）。カテゴリ選択欄の横に「+」ボタンを置き、`CreateAlbumCategoryModal`を開く。送信で`GET /albums/search`を呼び`searchResults` signalにセット

**`AlbumPage`（下部）:**
- `selectedDate`がセットされている場合: `GET /albums?date=...`でその日のアルバム一覧を取得。0件なら「アルバムを作成」ボタン(クリックで`CreateAlbumModal`を開く、dateを引き継ぐ)。1件以上ならそれぞれを`AlbumBlock`として縦に並べる
- `searchResults`がセットされている場合（条件検索実行後）: 結果を簡易リスト（タイトル・日付・カテゴリ色チップ）として表示し、クリックした1件を`AlbumBlock`として下に展開表示
- `AlbumBlock`（新規コンポーネント）: 「タイトル + 写真追加(+)ボタン + 設定(歯車)ボタン」を1つの枠（border + padding）で囲んだヘッダー、その下に`AlbumPhotoGrid`
  - +ボタン: ファイル選択 → Autumn `/attachments`へ直接アップロード（`Composition.tsx`の`addFile`/`Draft.ts`のXHRアップロードと同じ方式を流用してよい、ファイルサイズ検証も既存の`maxSize`チェックパターンを再利用）→ 成功したら`POST /albums/:id/photos`でメタデータ登録
  - 歯車ボタン: `EditAlbumModal`を開く（タイトル・閲覧権限・編集権限・カテゴリの編集、「アルバムを削除」ボタンで`DeleteAlbumModal`へ）

### 2.5 `AlbumPhotoGrid.tsx`（新規）
Discordの複数画像添付レイアウトを参考に、枚数に応じたCSS Gridレイアウトを実装:
- 1枚: 全幅1枠（`SizedContent`と同様の`objectFit: contain`、最大サイズは適宜）
- 2枚: 横に2分割
- 3枚: 1枚を縦長で左、右側を2分割（Discordのいわゆるpinwheel/L字レイアウト）
- 4枚以上: 2x2グリッド。5枚目以降がある場合は4枚目に半透明オーバーレイで`+N`（残り枚数）を表示
- 各セルはクリックで既存の `openModal({ type: "image_viewer", file })` を呼ぶ。`file`は`album_photos`のレコード（`autumnId`, `tag`, `metadata`, `filename`, `contentType`, `size`）から`new File(client, { _id: autumnId, tag, metadata, filename, content_type: contentType, size })`相当で構築する（`File`コンストラクタが`Pick<APIFile,"_id"|"tag"|"metadata"> & Partial<APIFile>`を受け付けるため、stoat.jsの`Message`を経由せず直接インスタンス化できる）

### 2.6 モーダル（`components/modal/modals/`、新規）
- `CreateAlbum.tsx`: タイトル、日付（`selectedDate`から引き継ぎ、別日付に変更も可）、閲覧権限セレクト（`anyone`/`members` + メンバーピッカー）、編集権限セレクト（`anyone`/`creator_only`/`members` + メンバーピッカー）、カテゴリ複数選択チェックボックスリスト + 「+」ボタンで`CreateAlbumCategoryModal`。フォーム構造は`CreateEvent.tsx`と同じ`solid-forms`パターンを流用
- `EditAlbum.tsx`: 同フィールドを編集（既存値プリフィル）。`editPermission`/`viewPermission`の変更は作成者のみ有効化（`EditEvent.tsx`の読み取り専用化パターンと同様）。「アルバムを削除」ボタンで`DeleteAlbumModal`を開く
- `DeleteAlbum.tsx`: 確認ダイアログ（`DeleteEvent.tsx`と同パターン）
- `CreateAlbumCategory.tsx`: 名前 + `<input type="color">`（`ServerRoleEditor.tsx`の色入力パターンを流用）。検索フォームの+ボタンとアルバム作成/編集モーダルの+ボタン、両方から開けるよう汎用化する
- `components/modal/types.ts`の`Modals`unionに上記4種の型を追加

### 2.7 APIクライアント `src/api/album.ts`（新規）
`src/api/calendar.ts`の`CalendarApiClient`と同じ構造（`getAuthHeaders`で`X-Session-Token`+`X-Server-Id`）で`AlbumApiClient`を実装。メソッド: `listCategories`, `createCategory`, `listAlbumsByDate`, `listAlbumDateColors`, `searchAlbums`, `createAlbum`, `getAlbum`, `updateAlbum`, `deleteAlbum`, `listPhotos`, `addPhoto`, `deletePhoto`。`useAlbumApi()`シングルトンフックも用意。

### 2.8 `env.ts`への追加
`DEFAULT_STORAGE_API_URL`/`DEFAULT_CALENDAR_API_URL`と同じ並びで`DEFAULT_ALBUM_API_URL`を追加（`VITE_ALBUM_API_URL`、devは`VITE_DEV_ALBUM_API_URL`、デフォルト値`http://local.sawarachats.chat/album/api/v1`）。

---

## 3. 注意点（既知のハマりどころ）

- **lingui罠**: 新規UIの文字列は`<Trans>`/`t`マクロを使わず日本語をハードコードする（カタログ未コンパイルでハッシュ文字列表示になる既知バグ）
- **Docker再ビルド**: `SCv2_for-web`編集後は`docker build -t sawarachats-web .`→`docker compose up -d web`、新規`album-api`編集後は`docker compose up -d --build album-api`が毎回必要（自動リビルドされない）
- **fastifyプラグインバージョン**: 新サービスの`package.json`は`calendar-api`の現行バージョン（fastify-5系: cors `^11`, helmet `^13`, rate-limit `^11`）をそのまま見て使う
- **FloatingSelect (`Form2.Select`)のPlaywright操作**: トリガーを現在値テキストでクリック→`mdui-menu-item`を完全一致テキストでクリック（部分一致が衝突する）

## 検証方法
1. `services/album-api`を`docker compose up -d --build album-api`で起動し、`/health`が200を返すことを確認
2. フロントを`docker build && docker compose up -d web`でデプロイ後、ブラウザでサーバーを開き、サイドバーに「アルバム」ボタンが表示されることを確認
3. アルバムパネルを開き、ミニカレンダーで日付クリック→「アルバムを作成」→作成モーダルでタイトル/権限/カテゴリ設定→作成→`AlbumBlock`が表示されることを確認
4. +ボタンから画像を複数枚アップロードし、`AlbumPhotoGrid`が枚数に応じたレイアウト（1/2/3/4+）で表示されること、クリックで既存の`image_viewer`モーダルが開くことを確認
5. 条件検索（アルバム名・日付範囲・カテゴリ）で結果が絞り込まれることを確認
6. 別アカウント（権限なしメンバー）で編集権限・閲覧権限の制限が効くことを確認（403/非表示）
7. 同日に2件以上アルバムを作成し、縦に並んで表示されることを確認
8. アルバムを削除し、写真も含めて削除されることを確認
