# 第三者テスト用の外部公開設定(一時変更・記録用)

> **2026-06-27 追記**: 本ドキュメントが「未コミット」と説明している
> Caddyfile/compose.yml/Revolt.toml/.env.web の一時変更は、テスト後の通常運用に
> 戻すため別コミットで `local.sawarachats.chat` 前提の状態に揃え直した(以後の
> 内容は記録としてそのまま残す)。なお `storage-api`/`calendar-api`/`stamp-api`の
> `CORS_ORIGIN`への`http://211.128.55.46:8080`追記は、既存の`mc-manager-api`/
> `album-api`/`gameclips-api`が同じIPを既に永続的にCORS許可リストへ含めていた
> (過去のコミット済み)ことに合わせて、そのまま残してコミットしている。

2026-06-22、第三者にテストしてもらうため、グローバルIP `211.128.55.46` 経由で
`local.sawarachats.chat` ドメイン前提だったDocker構成を一時的に書き換えた。
**これらはすべて未コミットのローカル変更**(`git status` で確認できる)。
テストが終わったら下記コマンドで即座に元へ戻せる。

## 元に戻す方法(テスト終了後)

```bash
cd SCv2_self-hosted
git checkout -- Caddyfile compose.yml Revolt.toml .env.web
docker compose up -d --force-recreate caddy web api events autumn january gifbox crond pushd voice-ingress storage-api calendar-api
```

これで `local.sawarachats.chat`(ポート80)を前提にした元の構成に戻る。

## 変更した4ファイルの内容

### `Caddyfile`
- 1行目を `http://local.sawarachats.chat {` → `:80 {` に変更。
- 理由: Caddyはサイトアドレスのホスト名でリクエストを振り分けるため、IPアドレスで
  アクセスされると元の設定では404になる。`:80`(ポート指定のみ)にすることで
  Hostヘッダーを問わずポート80(コンテナ内部)へのリクエストすべてに応答するようにした。

### `compose.yml`
- `caddy` サービスの `ports` を `"80:80"` → `"8080:80"` に変更。
  - 理由: ルーターのWAN側リモート管理画面(`Mini web server 1.0 ZTE corp 2005.`)が
    ホストのポート80を握ってしまい、ポート転送ルールより優先されてしまうことが
    判明したため、外部公開ポートを8080に変更した。
- `storage-api`・`calendar-api` の `CORS_ORIGIN` に `http://211.128.55.46:8080` を追記
  (既存の `http://local.sawarachats.chat,http://localhost:5173` はそのまま残し、追加のみ)。

### `Revolt.toml`
- `[hosts]` の `app`/`api`/`events`/`autumn`/`january`、`[hosts.livekit].worldwide` を
  すべて `local.sawarachats.chat` → `211.128.55.46:8080` に変更。
  - 理由: ここがクライアントに配布される実際の接続先になるため
    (`api`から取得する設定情報に含まれ、フロントエンドはこの値でWebSocket等に接続する)。
  - 影響範囲: `Revolt.toml` をマウントしている `api`・`events`・`autumn`・`january`・
    `gifbox`・`crond`・`pushd`・`voice-ingress` の再起動が必要。

### `.env.web`
- `HOSTNAME`・`REVOLT_PUBLIC_URL`・`VITE_API_URL`・`VITE_WS_URL`・`VITE_MEDIA_URL`・
  `VITE_PROXY_URL` を `local.sawarachats.chat` → `211.128.55.46:8080` に変更。
- `VITE_STORAGE_API_URL`・`VITE_CALENDAR_API_URL` を新規追加(後述の永続的修正により
  これらも実行時に注入できるようになったため、ここで明示的に指定)。

## 関連する永続的な修正(コミット済み・元に戻さない)

上記の一時変更を作業中に、`VITE_STORAGE_API_URL`/`VITE_CALENDAR_API_URL` がそもそも
実行時に注入できない(ビルド時に固定の `local.sawarachats.chat` がハードコードされ、
コンテナ起動時の環境変数を反映できない)という既存の設計ギャップを見つけたため、
これは別途**正式な修正としてコミットした**(`SCv2_for-web` の `Dockerfile`・
`docker/inject.js`)。この修正自体は今回のIP対応に限らず常に有効な改善であり、
元に戻す対象ではない。

## ルーターのポートフォワーディング設定(参考)

- 外部(WAN)ポート: `8080`
- 転送先 内部IP: `192.168.1.12`(このMac)
- 転送先 内部ポート: `8080`
- プロトコル: TCP

ポート80はルーター自身のWAN側管理画面が掴んでいるため使用不可だった
(`curl -i http://211.128.55.46/` のレスポンスヘッダーに
`Server: Mini web server 1.0 ZTE corp 2005.` と出ることで判明)。

## テスト用URL

`http://211.128.55.46:8080`
