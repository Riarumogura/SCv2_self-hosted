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

## 4. 今回触れていない既知の課題

- ストレージ作成成功後、`ServerSidebar.tsx` のストレージ一覧が自動更新されない(3-3参照、フェーズ3未着手のため)。
- `local.sawarachats.chat` のトップ(ログイン前)画面で、見出しテキストが `SEe2gT` / `TRrorc` という文字化けで表示される(`FlowHome.tsx` の `<Trans>Find your community...</Trans>` 等が正しく表示されていない、i18nカタログ関連の不具合と推測)。ログイン機能自体は阻害しないため未対応。
- `SCv2_self-hosted` リポジトリでは `services/storage-api/node_modules` が `.gitignore` 対象外でgit管理されている。本来 `npm ci` で再生成されるべきものであり、今後 `.gitignore` に追加して整理することを推奨する。
