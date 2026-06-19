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

## 4. 今回触れていない既知の課題

- `local.sawarachats.chat` のトップ(ログイン前)画面で、見出しテキストが `SEe2gT` / `TRrorc` という文字化けで表示される(`FlowHome.tsx` の `<Trans>Find your community...</Trans>` 等が正しく表示されていない、i18nカタログ関連の不具合と推測)。ログイン機能自体は阻害しないため未対応。
- `SCv2_self-hosted` リポジトリでは `services/storage-api/node_modules` が `.gitignore` 対象外でgit管理されている。本来 `npm ci` で再生成されるべきものであり、今後 `.gitignore` に追加して整理することを推奨する。
