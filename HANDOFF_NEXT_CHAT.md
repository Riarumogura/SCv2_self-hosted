# SawaraChats 引き継ぎプロンプト(オンラインストレージ機能・続き)

以下をそのまま新しいチャットに貼り付けて使用してください。

---

## プロジェクト概要

- アプリ名: SawaraChats(Stoat/Revolt のフォークベース、オープンコア商用化プロジェクト)
- リポジトリ:
  - `/Users/wakisakahayato/GitHub/SawaraChats_v2/SCv2_self-hosted` — self-hosted Fork(バックエンド・Docker構成・追加サービス)
  - `/Users/wakisakahayato/GitHub/SawaraChats_v2/SCv2_for-web` — for-web Fork(フロントエンド、SolidJS)
- 起動方法:
  - Docker Compose(本番相当): `cd SCv2_self-hosted && docker compose up -d` → `http://local.sawarachats.chat`
  - 開発サーバー(Vite、ソース直読み): `cd SCv2_for-web && mise run dev` → `http://localhost:5173`
- 言語: TypeScript / パッケージマネージャー: pnpm(for-web)、npm(storage-api)

## ⚠️ 最重要の運用ルール(必ず最初に読むこと)

1. **`SCv2_for-web` のコードを変更したら、Dockerの `web` コンテナは自動更新されない**。
   `image: sawarachats-web` を参照するだけで `build:` 設定が無いため、変更後は必ず:
   ```bash
   cd SCv2_for-web && docker build -t sawarachats-web .
   cd ../SCv2_self-hosted && docker compose up -d web
   ```
   を実行すること。`mise run dev`(`localhost:5173`)はVite経由でソースを直接見るため、こちらは常に最新。
   **「Dockerで動かしているのにコードの修正が反映されない」場合は、まずこれを疑うこと。**

2. **`services/storage-api` を変更したら**:
   ```bash
   cd SCv2_self-hosted && docker compose up -d --build storage-api
   ```

3. **`SCv2_for-web/packages/client/.env` は `.gitignore` 対象でリポジトリに含まれない**。
   新しい環境では以下の内容で作成しないと、開発サーバー(`localhost:5173`)が誤って本番の `https://stoat.chat` に繋がってしまう:
   ```env
   VITE_API_URL=http://local.sawarachats.chat/api
   VITE_WS_URL=ws://local.sawarachats.chat/ws
   VITE_MEDIA_URL=http://local.sawarachats.chat/autumn
   VITE_PROXY_URL=http://local.sawarachats.chat/january
   VITE_STORAGE_API_URL=http://local.sawarachats.chat/storage/api/v1
   VITE_CFG_ENABLE_VIDEO=true
   ```

4. **コミット前は `git status` で `secrets.env` 系を絶対に `git add` しないこと**(self-hosted側)。

5. `services/storage-api/node_modules` が誤って git 管理されている(`.gitignore` 未整備)。Dockerビルドは `npm ci` で再生成するので実害は無いが、ノイズが多いので触る際は注意(今回のセッションでは意図的に放置している)。

## これまでの作業内容(詳細は `SCv2_self-hosted/BUGFIX_LOGIN_AND_STORAGE.md` を参照)

直前のセッションで「ログイン/サインアップができない」「ストレージUIが表示されない」「ストレージ作成時にエラーが出る」という3件の報告を順に調査・修正した。最終的に見つかった原因は10個近くあり、すべて `BUGFIX_LOGIN_AND_STORAGE.md` に詳細を記録済み。要点だけ書くと:

- 開発サーバーが `.env` 未設定で本番Stoatに繋がっていた
- `storage-api` がFastify v4専用バージョンのプラグインでクラッシュループしていた
- フロントエンドとバックエンドでAPIのURL構造が不一致(`/servers/{id}/storages` vs `/storage` + `X-Server-Id`ヘッダー)
- 認証プラグインが `fastify-plugin` でラップされておらず認証情報が伝播していなかった
- 認証ヘッダーが `Authorization: Bearer` 前提だったが実際は `X-Session-Token`
- `STOAT_API_URL` のポート番号が間違っていた(3000 → 14702)
- CORSが `DELETE`/`PATCH` を許可していなかった
- 認証チェックがリクエスト毎にStoat APIへ2回問い合わせていてレートリミットに達しやすかった(30秒キャッシュを追加)
- Dockerの `web` イメージが再ビルドされておらず古いコードのまま動いていた

直近のコミット(参照用):
- `SCv2_self-hosted`: `37c8511` → `4f21817` → `b683dbe` → `5336b36`(最新)
- `SCv2_for-web`: `846cc259` → `bc201497`(最新)

## 現在の状態(動作確認済み)

`localhost:5173` と `local.sawarachats.chat` の両方で、以下が一通りエラーなく動作することを確認済み:
- サインアップ・ログイン
- サーバー作成
- ストレージ作成(サイドバーに即時反映される)
- ストレージエクスプローラーを開く
- 新規フォルダ作成
- ファイルアップロード(ファイル選択 / ドラッグ&ドロップ)
- ファイルダウンロード
- ファイル削除
- 容量・使用量のカウント(`usedSize`/`fileCount`)、サーバー全体の容量制限チェック
- パストラバーサル(`../`)対策

## 未実装・既知の課題(次にやること)

`STORAGE_HANDOFF_P3.md`(フェーズ3計画)のうち、まだ手を付けていないもの:

1. **フォルダ名変更・移動** — バックエンドに該当APIなし
2. **フォルダ削除** — `MinioService.deleteFolder()` は実装済みだが、対応するAPIルート・UIボタンが無い
3. **インラインプレビュー**(画像・動画・PDF・テキスト)— 未実装
4. **検索バー** — `StorageExplorer.tsx` 内のクライアントサイド簡易フィルタのみ。サーバーサイド検索なし
5. **容量表示バー**(使用量/上限のUI表示)— APIはあるが(`GET /storage/server/limits`、各ストレージの`usedSize`/`sizeLimit`)、UIへの表示が未実装
6. **ストレージの更新・削除のUI** — `PATCH`/`DELETE /storage/:storageId` のAPIはあるが、サイドバーやモーダルからの操作UIが無い

その他の既知バグ(優先度低、機能を阻害しない):
- `local.sawarachats.chat` のログイン前トップ画面で見出しテキストが `SEe2gT` / `TRrorc` のように文字化けする(`FlowHome.tsx` の `<Trans>` 関連、i18nカタログの不具合と推測。未調査)

## 作業の進め方について

- 何か変更したら、**必ず実機(ブラウザ)で動作確認すること**。Playwright + ローカルのChromeで自動操作して確認するのがこれまでのやり方(`executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"` でheadless起動、`@playwright/test` は `SCv2_for-web/packages/client` 配下で既に利用可能)。
- 修正したら `BUGFIX_LOGIN_AND_STORAGE.md` に追記し、`SCv2_self-hosted` と `SCv2_for-web` 両方のリポジトリで個別にコミット・pushする(コミットメッセージは日本語、`fix:`/`feat:`/`docs:` プレフィックス)。
- `services/storage-api/node_modules` や、作業に関係ない既存の未コミット差分(`STORAGE_HANDOFF_P3.md`、`packages/solid-livekit-components` サブモジュール)はコミット対象に含めないこと。
