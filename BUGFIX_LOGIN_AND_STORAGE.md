# 不具合調査・修正レポート: ログイン/サインアップ不可 & オンラインストレージUI未表示

## 1. 発生していた問題

1. サーバーを起動してもログイン・サインアップができない
2. サーバーを起動してもオンラインストレージ機能のUIが表示されず、機能が実装されているか確認できない

## 2. 調査方法

Docker Compose スタック (`http://local.sawarachats.chat`) と開発サーバー (`mise run dev` → `http://localhost:5173`) の両方を、Playwright のヘッドレスブラウザで実際に操作して検証した。

## 3. 原因と修正内容

### 3-1. ログイン・サインアップができない(開発サーバー側)

**原因**

`SCv2_for-web/packages/client/.env` が存在せず(`.env.example` のみ配布)、`components/common/lib/env.ts` のフォールバックにより API 接続先が本番の `https://stoat.chat/api` になっていた。

```ts
const DEFAULT_API_URL =
  (import.meta.env.DEV ? import.meta.env.VITE_DEV_API_URL : undefined) ??
  (import.meta.env.VITE_API_URL as string) ??
  "https://stoat.chat/api";   // ← .envが無いとここに落ちる
```

実機検証で `localhost:5173` からのログイン要求が実際に `https://stoat.chat/api/auth/session/login` に送信され、本番サーバーから401が返っていたことを確認した。ローカルで作成したテストアカウントは本番に存在しないため、ログイン・サインアップが機能しているように見えなかった。

なお `.env.example` に書かれている `http://localhost:14702` 等のポートも、`compose.yml` ではホストに公開されていない(コンテナ内部専用)ため、そのままコピーしても接続できない。

**修正内容**

`SCv2_for-web/packages/client/.env` を新規作成し、`.env.web`(本番/Docker版web向け設定)と同じ値を使い、Caddy経由でローカルDockerスタックに接続するよう設定した。

```env
VITE_API_URL=http://local.sawarachats.chat/api
VITE_WS_URL=ws://local.sawarachats.chat/ws
VITE_MEDIA_URL=http://local.sawarachats.chat/autumn
VITE_PROXY_URL=http://local.sawarachats.chat/january
VITE_STORAGE_API_URL=http://local.sawarachats.chat/storage/api/v1
VITE_CFG_ENABLE_VIDEO=true
```

`.env` は `.gitignore` 対象のため、リポジトリには含まれない。**新規環境では、このファイルを `SCv2_for-web/packages/client/.env` に作成する必要がある。**

**確認結果**

開発サーバー再起動後、サインアップ→アカウント作成(204)→自動ログイン(200)→オンボーディング完了→アプリ画面到達まで、エラーなく完走することを確認した。

---

### 3-2. オンラインストレージ機能のUIが表示されない

`storage-api` コンテナが起動直後にクラッシュし、`Restarting` を無限に繰り返していたことが根本原因。3つの個別バグが連鎖していた。

#### (a) Fastify v5 とプラグインのバージョン不整合

`services/storage-api/package.json` で `fastify: ^5.0.0` を使用しているにもかかわらず、以下のプラグインがFastify v4専用バージョンのまま指定されていた:

| パッケージ | 修正前 | 修正後 |
|---|---|---|
| `@fastify/cors` | `^9.0.1` (v4専用) | `^11.2.0` |
| `@fastify/helmet` | `^11.0.0` (v4専用) | `^13.0.2` |
| `@fastify/rate-limit` | `^9.0.0` (v4専用) | `^11.0.0` |

起動ログ:
```
FastifyError: fastify-plugin: @fastify/cors - expected '4.x' fastify version, '5.8.5' is installed
```

#### (b) Zodスキーマを生のままFastifyの`schema`オプションに渡していた

`src/routes/storage.ts` の `POST /` (ストレージ作成) と `PATCH /:storageId` (ストレージ更新) で、Fastifyの標準バリデータ(AJV)が解釈できないZodオブジェクトをそのまま `schema.body` に渡していたため、(a)を修正した後に新たに以下のクラッシュが発生した:

```
FastifyError: Failed building the validation schema for POST: /api/v1/storage,
due to error schema is invalid: data/required must be array
```

修正として、Fastifyの `schema` オプションを使わず、ハンドラ内で `zodSchema.safeParse(request.body)` による手動検証に変更した。

#### (c) Caddyfileのリバースプロキシ先ポートの誤り

```caddyfile
# 修正前
reverse_proxy http://storage-api:3000  # ← だったものが3001になっていた
```

`compose.yml` では `ports: ["3001:3000"]` と定義されているが、`3001` はホストマシンへの公開用ポートであり、Docker内部ネットワーク(Caddy→storage-api間の通信)ではコンテナの実リスニングポートである `3000` を使う必要がある。`3001`を指定していたためCaddyからは常に `502 Bad Gateway` になっていた。

**修正内容**

- `services/storage-api/package.json`: 上記3パッケージのバージョンを更新
- `services/storage-api/src/routes/storage.ts`: 2箇所のルートでZodスキーマを `schema.body` 経由ではなく `safeParse` による手動検証に変更
- `Caddyfile`: `storage-api:3001` → `storage-api:3000`

**確認結果**

- `docker compose ps` で `storage-api` が `Restarting` から `Up` に変化
- `curl http://localhost:3001/health` → `200 {"status":"ok",...}`
- `curl http://local.sawarachats.chat/storage/health` (Caddy経由) → `200 ok`(修正前は `502`)
- `curl http://local.sawarachats.chat/storage/api/v1/storage` (認証なし) → `401`(修正前は `502`)

これにより、フロントエンドからのストレージ一覧取得・作成APIが正しく到達できるようになった。

なお `STORAGE_HANDOFF_P3.md` に記載の通り、ストレージエクスプローラーUI自体(ファイル一覧・アップロード・プレビュー等)はフェーズ3として未実装のプレースホルダーであり、これは既知の状態であって今回のバグとは無関係である。

---

### 3-3. ストレージ作成時に「エラーが発生しました」が出る

3-2の修正後、`storage-api` 自体は起動するようになったが、実際に名前・容量を入力してストレージを作成しようとすると依然としてエラーになった。実機で再現したところ、**5つの個別バグが直列に連鎖**していた(1つ直すと次のバグが現れる、という状態を5回繰り返した)。

#### (a) `useClient()` をリクエスト時に遅延呼び出ししていた

`src/api/storage.ts` の `StorageApiClient.getAuthHeaders()` が、ストレージ作成ボタンを押した時点(イベントハンドラ内の非同期処理)で初めて `useClient()` を呼んでいた。SolidJSの `useContext` 系フックは、コンポーネントのセットアップ時点(同期的なreactive ownerが有効な間)に呼ぶ必要があり、イベントハンドラ内の非同期コールバックから呼ぶとownerが失われ `null` が返る。結果として以下のエラーがダイアログに表示されていた:

```
An error occurred.
Cannot read properties of null (reading 'getCurrentClient')
```

**修正**: `useStorageApi()` が呼ばれる(＝コンポーネントのセットアップ時点で実行される)`StorageApiClient` のコンストラクタで `useClient()` を呼んで結果を保持し、`getAuthHeaders()` ではその保持した値を使うように変更した。

#### (b) CORSが `localhost:5173` を許可していなかった

`storage-api` の `CORS_ORIGIN` は `http://local.sawarachats.chat` のみが許可されていたため、`mise run dev`(`http://localhost:5173`)から呼び出すと以下のブラウザエラーになっていた:

```
Access to fetch at 'http://local.sawarachats.chat/storage/api/v1/...' from origin
'http://localhost:5173' has been blocked by CORS policy
```

**修正**: `services/storage-api/src/config.ts` の `corsOrigin` をカンマ区切りで複数オリジンを受け付けるように変更し、`compose.yml` の `CORS_ORIGIN` に `http://localhost:5173` を追加した。

#### (c) フロントエンドとバックエンドでAPIエンドポイントの形が不一致

`STORAGE_HANDOFF_P3.md` の既知の課題に記載されていた問題が実際に発生していた。フロントエンド(`src/api/storage.ts`)は `/servers/{serverId}/storages` という構造のURLを呼んでいたが、バックエンド(`src/routes/storage.ts`)は `serverId` をURLに含めず `X-Server-Id` ヘッダーで受け取る前提の `/api/v1/storage` というフラットな構造で実装されていた。結果、`404 Route POST:/api/v1/servers/{serverId}/storages not found` になっていた。

**修正**: フロントエンドのAPIクライアントを、バックエンドの実装(`/storage`、`X-Server-Id` ヘッダー渡し)に合わせて修正した。ファイル/フォルダ操作系メソッド(`listFiles`/`uploadFile`/`saveToStorage`/`deleteFile`/`createFolder`)はバックエンド側に対応するルートがまだ存在しない(フェーズ3未着手)ため、今回は型の整合のみ修正し、URL構造は変更していない。

#### (d) 認証プラグインが `fastify-plugin` でラップされておらず、認証情報が反映されなかった

`src/plugins/auth.ts` の `authPlugin` が素のFastifyプラグインとして実装されており、`fastify.register(authPlugin)` のように単独で登録すると、`decorateRequest('user', ...)` と `onRequest` フックがその登録呼び出し自身のカプセル化スコープに閉じてしまう。兄弟として登録されていた `storageRoutes` にはこの認証情報が一切伝播せず、ルートハンドラの `if (!request.user)` が常に真になり、**有効なトークンでも常に `401 Unauthorized`** になっていた。

**修正**: `fastify-plugin` (`fp()`) で `authPlugin` をラップしてカプセル化を解除した。ただし `fp()` でラップするとフックがルートスコープに広がり `/health` 等の無関係なルートにも認証が必要になってしまうため、`index.ts` で `authPlugin` と `storageRoutes` を同じ子コンテキストにネストして登録し、認証フックの適用範囲を `/api/v1/storage` 配下に限定した。

#### (e) 認証ヘッダーの形式の不一致(`Authorization: Bearer` vs `X-Session-Token`)

`authPlugin` は `Authorization: Bearer <token>` ヘッダーを期待していたが、Stoat(Revolt)の実際のセッション認証は独自の `X-Session-Token` ヘッダーを使う(`stoat.js` の `Client#authenticationHeader` も同様)。フロントエンドは正しく `X-Session-Token` を送っていたため、`authPlugin` 側はこれを「ヘッダーが無い」と判定し、`401 Authorization header missing or invalid` になっていた。

**修正**: `authPlugin` が `X-Session-Token` ヘッダーを読み取り、Stoat APIへの検証リクエスト(`/users/@me`、`/servers/{serverId}/members/{userId}`)にも同じ `X-Session-Token` ヘッダーを使うように変更した。

#### (f) `STOAT_API_URL` のポート番号の誤り

(e)を修正した後も `401 Invalid or expired token` になっていた。原因は `compose.yml` の `STOAT_API_URL: http://api:3000` で、`api` コンテナの実際のリスニングポートは `14702`(Caddyfileの `reverse_proxy http://api:14702` と同じ)だったため、`storage-api` から Stoat APIへの検証リクエスト自体が到達できず例外になっていた。

**修正**: `compose.yml` の `STOAT_API_URL` を `http://api:14702` に修正した。

**修正ファイル一覧(3-3関連)**

- `SCv2_for-web/packages/client/src/api/storage.ts`(a, c)
- `SCv2_self-hosted/services/storage-api/src/config.ts`(b)
- `SCv2_self-hosted/compose.yml`(b, f)
- `SCv2_self-hosted/services/storage-api/src/plugins/auth.ts`(d, e)
- `SCv2_self-hosted/services/storage-api/src/index.ts`(d)
- `SCv2_self-hosted/services/storage-api/package.json`(d: `fastify-plugin` を依存に追加)

**確認結果**

`localhost:5173` の開発サーバーから実際にサーバーを作成し、サイドバーの「ストレージ」セクションから「作成する」→ 名前・容量を入力 → 作成を実行したところ、エラーダイアログは出ず、`storage-api` への `POST /api/v1/storage` が `201 Created` で成功することを確認した:

```
201 POST http://local.sawarachats.chat/storage/api/v1/storage
:: {"id":"th0uk0z1","name":"MyTestStorage","sizeLimit":10737418240,"createdAt":"..."}
```

なお、`ServerSidebar.tsx` のストレージ一覧(`storages` シグナル)は作成後に再取得する処理がまだ実装されていない(初期値 `[]` のまま固定)ため、作成自体は成功してもサイドバーの表示は「ストレージがありません」のままになる。これは今回の「エラーが発生する」という不具合とは別の、フェーズ3で予定されている表示更新機能の未実装によるものであり、エラーではない。

---

## 4. ストレージ機能フェーズ3実装: エクスプローラーUI・ファイル操作

3-3で「ストレージの作成」自体は直ったが、`STORAGE_HANDOFF_P3.md` に記載の通り以下は未実装のままだった:
- 作成したストレージがサイドバーの一覧に出てこない(作成後に再取得していない)
- ストレージをクリックしてもエクスプローラーが開かない(`console.log` のみ)
- フォルダ作成・ファイルアップロード・ダウンロード・削除のバックエンドAPIが存在しない

これらを実装し、実際にブラウザ操作で最後まで動くことを確認した。

### 4-1. バックエンド: ファイル/フォルダ操作APIの実装

`services/storage-api` には `POST/GET/PATCH/DELETE /storage` (ストレージ自体のCRUD) しか実装されておらず、ファイル一覧・アップロード・ダウンロード・削除・フォルダ作成のルートが存在しなかった(`src/api/storage.ts` のフロントエンドクライアントだけが先に実装されていた状態)。以下を新規実装した:

- `GET /:storageId/files?path=` — 指定パス直下のファイル/フォルダ一覧(非再帰)
- `POST /:storageId/files` — ファイルアップロード(`@fastify/multipart`)
- `GET /:storageId/files/download?path=` — ファイルダウンロード(ストリーミング)
- `POST /:storageId/files/copy` — チャット添付ファイルのURLを取得してストレージに保存
- `DELETE /:storageId/files` — ファイル削除
- `POST /:storageId/folders` — フォルダ作成(空オブジェクトのマーカーを置く方式)

あわせて `MinioService` に非再帰一覧取得用の `listFilesAndFolders()` とストリーミングダウンロード用の `getObjectStream()` を追加。アップロード/削除時には `MongoDBService.updateStorageUsage()` で使用量を増減させ、アップロード前に `checkStorageLimit`/`checkServerStorageLimit` で容量超過を防止している。

**セキュリティ対策**: クライアントから渡される `path`/`destinationPath` はそのままMinIOのオブジェクトキーに組み込まれるため、`../` 等によるディレクトリトラバーサルを防ぐ `sanitizePath()` を実装し、全ファイル/フォルダ操作ルートで適用した(`../../etc` → `etc` に正規化されることを確認済み)。

`@fastify/multipart` (Fastify v5対応の `^10.0.0`) を依存に追加。

### 4-2. CORSがDELETE/PATCHをブロックしていた(7つ目のバグ)

エクスプローラーから「削除」を実行すると以下のエラーになった:

```
Access to fetch at '.../storage/api/v1/storage/.../files' from origin '...'
has been blocked by CORS policy: Method DELETE is not allowed by
Access-Control-Allow-Methods in preflight response.
```

`@fastify/cors` のデフォルト `methods` は `'GET,HEAD,POST'` のみで、PATCH/DELETEを使うこのAPIには不十分だった。`index.ts` の `cors` 登録に `methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS']` を明示して解消した。

### 4-3. 認証チェックがStoat APIのレートリミットに達しやすい設計だった

`authPlugin` はリクエストごとに Stoat API へ2回(`/users/@me`、`/servers/{id}/members/{id}`)問い合わせる実装で、エクスプローラーでの一覧更新やアップロードを連続して行うと、Stoat API側のレートリミット(`429 Too Many Requests`)にすぐ達してしまい、`401 Invalid or expired token` という誤解を招くエラーになっていた。トークン+サーバーIDの組み合わせをキーに30秒のインメモリキャッシュを追加し、問い合わせ頻度を抑えた。あわせて、上流が429を返した場合は内部で握り潰さずそのまま `429` を返すよう修正した。

### 4-4. フロントエンド: エクスプローラーUIの実装とサイドバー連携

- `StorageExplorer.tsx`: 一覧取得を新APIレスポンス形式(`{ name, type: "file"|"folder", size, lastModified }`)に合わせて修正。フォルダクリックでの階層移動、新規フォルダ作成(`window.prompt`)、ファイルアップロード(ファイル選択 / ドラッグ&ドロップ両対応)、ダウンロード、削除(確認ダイアログ付き)を実装。
- `src/api/storage.ts`: `listFiles`/`uploadFile`/`saveToStorage`/`deleteFile`/`createFolder` のURLをバックエンドの実装(`/storage/:storageId/...` + `X-Server-Id` ヘッダー)に合わせて修正。`downloadFile()` を新規追加(Blob取得→一時URL生成)。型を `StorageFile` から `StorageEntry`(一覧用)/`UploadedFile`(作成・コピー結果用)に分離。
- `SelectFolder.tsx`: 一覧が新形式になったことに合わせて、存在しない `file.path` 参照を修正。フォルダクリックでその階層に移動できるよう修正(以前は実質機能していなかった)。
- `ServerSidebar.tsx`: マウント時 / ストレージ作成後に `getStorages()` で一覧を再取得するように修正(以前は空配列で固定だった)。ストレージ項目のクリックで実際にエクスプローラーを開けるようにした。
- `ServerSidebar.tsx` は `TextChannel.tsx` の子ではなく兄弟コンポーネントとして描画されているため、`TextChannel.tsx` のローカルな `sidebarState` を直接呼び出せない。`src/api/storageExplorerSignal.ts` という小さな共有シグナルを新設し、`ServerSidebar` → (共有シグナル) → `TextChannel` の一方向データフローで「どのストレージを開くか」を伝達するようにした。
- `components/modal/types.ts` / `CreateStorage.tsx`: `create_storage` モーダルに `onCreated?: () => void` コールバックを追加し、作成成功時に `ServerSidebar` 側の一覧再取得をトリガーできるようにした(`select_folder` モーダルの `onSelect` と同じパターン)。
- ついでに、このファイル群に残っていた既存の型エラー(`STORAGE_HANDOFF_P3.md`記載の既知の課題: CSSプロパティのキャメルケース指定、`Row align="center"` の誤用、`IconButton` への存在しない `title` prop、`ContextMenuButton` への誤った `_disabled` prop)も合わせて修正した。

### 確認結果

`localhost:5173` で実際に、サインアップ→サーバー作成→ストレージ作成→サイドバーに即時反映→クリックしてエクスプローラーを開く→新規フォルダ作成→ファイルアップロード→一覧表示→ダウンロード(内容が一致)→削除(一覧から消える)、までの一連の操作をエラーなく完走できることを確認した。`curl` でのAPI直接検証でも、使用量(`usedSize`/`fileCount`)が正しく増減することと、パストラバーサル対策が効くことを確認した。

---

## 5. 「エラーが発生してストレージが作成されない」(再発報告)の調査

4までの修正を行った後、改めて「ストレージ作成でエラーが発生する」という報告があった。

**調査**

`mise run dev`(`http://localhost:5173`、Viteがソースを直接配信)で再現を試みたところ、サインアップ→サーバー作成→ストレージ作成までエラーなく完走し(`201 Created`)、サイドバーにも即時反映された。再現しないため、もう一方の起動経路である Docker Compose スタック (`http://local.sawarachats.chat`、`sawarachats-web` というビルド済みイメージを使う `web` コンテナ)を確認した。

```
docker inspect sawarachats-web --format '{{.Created}}'
# => 2026-06-16T12:35:30Z (3日前)

git -C SCv2_for-web log -1 --format="%ad"
# => 2026-06-19 (最新のストレージ修正コミットを含む)
```

`web` コンテナの Docker イメージは、ストレージ機能関連のコミットを含む**3日分前**にビルドされたものを使い続けていた。実際に `local.sawarachats.chat` で確認すると、サイドバーに「ストレージ」セクション自体が表示されない(=今回の一連の修正がまったく反映されていない古いビルド)ことを確認した。

つまり今回の「サーバーを起動してもエラーが出る/動かない」という報告は、**`for-web` 側のソースコードは直っているが、Dockerで実際に動いている `sawarachats-web` イメージが古いビルドのまま再ビルドされていなかった**ことが原因だった可能性が高い。`mise run dev` (`localhost:5173`) はVite経由でソースを直接読むため最新化されるが、Docker Composeの `web` サービスは `image: sawarachats-web` を参照するだけで `build:` 設定が無く、**コード変更後に手動で `docker build` し直さない限り古いまま動き続ける**。

**対応**

```bash
cd SCv2_for-web
docker build -t sawarachats-web .
cd ../SCv2_self-hosted
docker compose up -d web
```

再ビルド後、`local.sawarachats.chat` で再度サインアップ→サーバー作成→ストレージ作成を行い、サイドバーに「ストレージ」セクションが表示され、作成したストレージが一覧に即時反映されることを確認した。エラーは発生しなかった。

**今後の注意点**

`SCv2_for-web` 側のコードを変更した場合、`mise run dev` で見えている内容と、Docker Compose で実際に動いている `local.sawarachats.chat` の内容は別物であり、**`docker build -t sawarachats-web . && docker compose up -d web` を実行しない限り本番相当の起動経路には反映されない**。同様に `services/storage-api` を変更した場合も `docker compose up -d --build storage-api` が必要。

---

## 6. 今回触れていない既知の課題

- `SCv2_self-hosted` リポジトリでは `services/storage-api/node_modules` が `.gitignore` 対象外でgit管理されている。本来 `npm ci` で再生成されるべきものであり、今後 `.gitignore` に追加して整理することを推奨する。
- 画像/PDF等のインラインプレビュー、サーバーサイド検索バー(エクスプローラー側はクライアントサイドの簡易フィルタのみ)は未実装(`STORAGE_HANDOFF_P3.md` のフェーズ3タスクの一部は依然未着手)。

## 7. フォルダ操作・ストレージ管理UI・容量表示バーの実装

`HANDOFF_NEXT_CHAT.md` に記載の未実装6項目のうち、以下4項目を実装した。

1. **フォルダ名変更・移動**
   - `storage-api`: `PATCH /storage/:storageId/folders`(body: `{ path, newPath }`)を追加。`MinioService.renameFolder()` でMinIO配下の全オブジェクトをコピー→削除してリネーム/移動を実現(S3/MinIOにネイティブなrenameはないため)。移動先がフォルダ自身の中になる場合は400を返す。
   - フロントエンド: `StorageExplorer.tsx` のフォルダ行に「名前変更」「移動」ボタンを追加。「移動」は既存の `select_folder` モーダルを再利用して移動先フォルダを選択する。
2. **フォルダ削除**
   - `storage-api`: `DELETE /storage/:storageId/folders`(body: `{ path }`)を追加。`MinioService.deleteFolder()` を拡張し、削除した合計サイズ・ファイル数を返すようにして、`storage_usage` の使用量を正しく減算するようにした。
   - フロントエンド: フォルダ行に「削除」ボタンを追加(確認ダイアログ付き)。
3. **容量表示バー**
   - サーバーサイドバーの「ストレージ」セクションに、`GET /storage/server/limits` を使ったサーバー全体の容量バー(使用量/上限/パーセンテージ)を追加。
   - 各ストレージ項目にも使用量テキスト(例: `0.0 GB / 256.0 GB`)を追加。
   - `StorageExplorer.tsx` のヘッダーにも、開いているストレージ単体の容量バー(使用量/上限/パーセンテージ/ファイル数)を追加。
4. **ストレージの更新・削除UI**
   - `storage-api` クライアント(`storage.ts`)に `updateStorage` / `deleteStorage` / `getServerLimits` を追加。
   - 新規モーダル `EditStorage.tsx`(名前・容量上限の変更)、`DeleteStorage.tsx`(削除確認)を追加し、サーバーサイドバーの各ストレージ項目に編集(鉛筆)・削除(ゴミ箱)アイコンを追加。

### 実装中に見つけた既存の不具合(今回まとめて修正)

- **ストレージ削除APIが二重スラッシュで失敗する**: `storage.ts` の「ストレージ削除」ルートは `MinioService.deleteFolder(serverId, storageId, '')` を呼ぶが、`deleteFolder` 内のプレフィックス組み立てが常に `.../storage_{id}/${folderPath}/` という形だったため、`folderPath` が空文字のときに `.../storage_{id}//` という二重スラッシュになり、MinIOが `XMinioInvalidObjectName` で拒否し500が返っていた。これまで「ストレージ全体を削除するUI」自体が存在しなかったため未発覚だった。`folderPath` が空の場合は末尾スラッシュを付与しないように修正。
- **`DELETE /storage/:storageId` がボディ無しリクエストで400になる**: フロントエンドの `deleteStorage()` がボディを送らないDELETEリクエストに `Content-Type: application/json` を付与していたため、Fastifyの標準JSONボディパーサーが空文字列のJSONパースに失敗し400 Bad Requestを返していた(`deleteFile`/`deleteFolder` はボディがあるため問題なし)。ボディを送らないリクエストでは `Content-Type` ヘッダーを外すよう修正。

### 新たに分かったi18nカタログの不具合の範囲

`HANDOFF_NEXT_CHAT.md` では「`FlowHome.tsx` の見出しのみが文字化けする」という認識だったが、調査の結果、**`<Trans>`/`t` macroを使っている箇所はすべて同様に文字化けする**ことが判明した(例: 既存の `CreateStorage.tsx` モーダルのラベル類、今回追加した `EditStorage.tsx`)。原因は `lingui extract && lingui compile` が、これらのコンポーネントが追加されて以降再実行されておらず、コンパイル済みカタログに該当メッセージIDが存在しないため、フォールバックとしてメッセージのハッシュID(`fV3qzy` のような6文字の文字列)がそのまま表示されてしまうこと。
一方、`ServerSidebar.tsx` の「ストレージ」セクションや `StorageExplorer.tsx` は方針通り `<Trans>` を使わず日本語をハードコードしているため、この影響を受けない。
影響はラベル文言の表示のみで機能は阻害しないため今回は未対応(カタログの再生成は全ロケール・全コンポーネントに渡る大きな差分になるため、別タスクとして対応することを推奨)。

### 動作確認

`local.sawarachats.chat` 上でPlaywright(ヘッドレスChrome)により以下を一通り確認した: サインアップ→サーバー作成→ストレージ作成→フォルダ作成→フォルダ名変更→フォルダ移動(移動先フォルダの中に正しく入ることを確認)→容量バー表示→フォルダ削除→ストレージ容量上限の編集→ストレージ削除(サイドバーから消え、サーバー全体の使用量も0に戻ることを確認)。
- フォルダの削除はバックエンド(`MinioService.deleteFolder`)には実装済みだが、対応するAPIルート・UIボタンは未実装。
