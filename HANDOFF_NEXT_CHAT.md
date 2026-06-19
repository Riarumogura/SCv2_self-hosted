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

5. `services/storage-api/node_modules` が誤って git 管理されている(`.gitignore` 未整備)。Dockerビルドは `npm ci` で再生成するので実害は無いが、ノイズが多いので触る際は注意(意図的に放置している)。

## ⚡ トークン使用量を抑えるための実装ルール(必ず守ること)

過去のセッションで、動作確認のためのPlaywright試行錯誤や、大きなファイルの全文読み込みでトークンを多く消費した。次回以降は以下を徹底する。

1. **Playwright確認は本ドキュメントの「動作確認の定型フロー」をそのまま使う。** 毎回 `explore*.mjs` のような調査用スクリプトを新規に作って試行錯誤しない。選択子は下記セクションに確定済みのものを記載しているので、それをコピーして使う。
2. **ファイルを読むときは関係する範囲だけを `offset`/`limit` で読む。** 特に `ServerSidebar.tsx`・`StorageExplorer.tsx`・`storage.ts`(APIクライアント)・`storage-api/src/routes/storage.ts` は数百行あるため、`grep` で対象行を先に特定してから必要な範囲のみ読むこと。
3. **型チェックはEdit/Write後に自動表示されるIDE診断(diagnostics)で十分。** モノレポ全体に対して `tsc --noEmit` を実行しない(対象パッケージ内で軽量に確認する程度に留める)。
4. **スクリーンショットは機能ひとつにつき1〜2枚(実装後の確認)に留める。** 毎操作ごとに撮影しない。
5. **動作確認用の一時スクリプトは `packages/client/e2e-manual/` 配下に作成し、確認が終わったら都度 `rm -rf` で削除してコミットしない。** リポジトリに残さない。
6. **編集は機能単位でまとめてから行う。** 1つのファイルに対して細切れに何度もEditを繰り返さず、変更点を整理してから編集する。
7. **このタスク規模ではサブエージェント(Agent tool)を使わない。** 直接ツールで実装・確認まで完結させる。
8. **Dockerの再ビルドは機能のまとまりごとに1回。** 1行修正するたびに再ビルドしない(関連する変更をまとめてから `docker build`/`docker compose up -d --build` を実行する)。
9. **既知の構造・パターンは本ドキュメントを正として参照し、コードを読んで再確認する手間を省く。** ただし「コードは変わっている前提」で、実装前に該当ファイルの該当箇所だけ`grep`/該当行読みで現状確認すること(本ドキュメントの記述を無条件に信用して実装しない)。

## 動作確認の定型フロー(Playwright、確定済み)

`local.sawarachats.chat` に対して、ヘッドレスChromeで以下の手順を踏めば毎回サインアップ〜ストレージ操作まで到達できる。新しいテストスクリプトを書くときはこの手順をそのままコピーする。

```js
import { chromium } from "@playwright/test"; // packages/client から実行すること

const browser = await chromium.launch({
  headless: true,
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
const page = await browser.newPage();

// dialog(window.prompt/confirm)はキューイングして処理する
const dialogQueue = [];
page.on("dialog", async (dialog) => {
  const handler = dialogQueue.shift();
  if (handler) await handler(dialog); else await dialog.accept();
});
const queuePrompt = (v) => dialogQueue.push((d) => d.accept(v));
const queueConfirm = (ok = true) => dialogQueue.push((d) => (ok ? d.accept() : d.dismiss()));

// 1. サインアップ
await page.goto("http://local.sawarachats.chat/login/create");
await page.locator('input[name="email"]').fill(email);
await page.locator('input[name="new-password"]').fill(password);
await page.getByRole("button", { name: "登録" }).click();
await page.waitForTimeout(2000);
await page.locator('input[name="username"]').fill(username);
await page.getByRole("button", { name: "確認" }).click();
await page.waitForTimeout(3000); // -> /app に到達

// 2. 「What's New」モーダルを閉じる
await page.keyboard.press("Escape");

// 3. サーバー作成(ホーム画面の "Create a group or server" カードから)
await page.getByText("Create a group or server").click();
await page.getByRole("button", { name: "Server", exact: true }).click();
await page.locator('input[name="name"], input').first().fill(serverName);
await page.getByRole("button", { name: /Create|作成/i }).last().click();
await page.waitForTimeout(2500); // -> /server/{id}/channel/{id} に到達

// 4. ストレージ作成(サイドバーの「ストレージ」セクション、空状態なら "作成する" ボタン)
await page.getByRole("button", { name: "作成する" }).click();
// ⚠️ CreateStorage/EditStorageモーダルは lingui の <Trans>/t macro を使っており、
//    カタログ未再生成のためラベルが "fV3qzy" のようなハッシュ文字列で文字化けする(既知バグ、後述)。
//    ラベルテキストでは要素を特定できないため、構造的セレクタを使う。
//    モーダルはportalでbody末尾に追加されるので、表示中input/buttonの末尾を使う。
const visibleInputs = page.locator("input:visible");
await visibleInputs.nth((await visibleInputs.count()) - 2).fill(storageName); // name欄
await page.locator("button:visible", { hasText: "作成" }).last().click();

// 5. ストレージエクスプローラーを開く(サイドバーのストレージ名をクリック)
await page.getByText(storageName).first().click();

// 6. フォルダ作成・名前変更・移動・削除(ハードコード日本語なのでテキストで特定できる)
queuePrompt("FolderA");
await page.getByRole("button", { name: "新規フォルダ" }).click();

const row = page.locator("tr", { hasText: "FolderA" }).first();
queuePrompt("FolderA-Renamed");
await row.getByRole("button", { name: "名前変更" }).click();

// 移動: SelectFolderModalが開く。フォルダ名ボタンは "📁 フォルダ名" の形式
await page.getByRole("button", { name: "移動" }).click(); // 該当行のボタン
await page.getByRole("button", { name: "📁 行き先フォルダ名" }).click();
// 「現在のパスを選択」ボタン(行き先フォルダ名を含む幅100%ボタン、Transで文字化けするため構造で特定)
await page.locator("button:visible").filter({ hasText: "行き先フォルダ名" }).last().click();
// ダイアログ決定ボタン(表示中ボタンの最後)
const btns = page.locator("button:visible");
await btns.nth((await btns.count()) - 1).click();

queueConfirm(true);
await row.getByRole("button", { name: "削除" }).click();

// 7. ストレージの編集・削除(サイドバーの鉛筆/ゴミ箱アイコン、Transで文字化けするため構造で特定)
// storageItem = テキストが storageName の要素から2階層上の親(StorageItem全体)
const storageItem = page.locator("text=" + storageName).first().locator("../..");
await storageItem.locator("button").first().click(); // 編集(鉛筆、1番目のボタン)
// EditStorageModal: 表示中inputの末尾がsizeLimit欄
const editInputs = page.locator("input:visible");
await editInputs.nth((await editInputs.count()) - 1).fill("512");
const editBtns = page.locator("button:visible");
await editBtns.nth((await editBtns.count()) - 1).click(); // 保存(表示中ボタンの最後)

await storageItem.locator("button").nth(1).click(); // 削除(ゴミ箱、2番目のボタン)
const delBtns = page.locator("button:visible");
await delBtns.nth((await delBtns.count()) - 1).click(); // 削除確定(表示中ボタンの最後)

// 8. サーバーサイド検索・インラインプレビュー(確定済み、フォルダ内にファイルをアップロード済みの状態から)
// 検索: デバウンス(300ms)があるので入力後はwaitForTimeoutで待つ。結果行には親パスが小さく表示される。
await page.locator('input[placeholder="ファイルを検索..."]').fill("ファイル名の一部");
await page.waitForTimeout(1000);
const searchRow = page.locator("tr", { hasText: "対象ファイル名.txt" }).first();
// プレビュー: ファイル行(名前セル)をクリックするとstorage_previewモーダルが開く
await searchRow.locator("td").first().click();
await page.waitForTimeout(1000);
// テキストファイルなら <pre> に内容が表示される。画像なら img[src^='blob:']、動画はvideo、PDFはiframe。
// 閉じるボタンはハードコード日本語なのでテキストで特定できる
await page.getByRole("button", { name: "閉じる" }).click();
// 検索ボックスを空にすると通常のフォルダ一覧表示に戻る
await page.locator('input[placeholder="ファイルを検索..."]').fill("");
```

## これまでの作業内容(詳細は `SCv2_self-hosted/BUGFIX_LOGIN_AND_STORAGE.md` を参照)

ログイン/サインアップ不可・ストレージUI未表示・ストレージ作成エラーの3件を修正済み(詳細は `BUGFIX_LOGIN_AND_STORAGE.md` の1〜5章)。続けて、フォルダ操作・容量表示バー・ストレージ管理UI(7章)、インラインプレビュー・サーバーサイド検索(8章)を実装済み。当初挙げていた未実装6項目はすべて完了した。

直近のコミット(参照用、コミット前時点では「8章実装後」が最新):
- `SCv2_self-hosted`: `787ceea` → `9acfec8`(7章)→(8章、本ドキュメント更新後にコミット)
- `SCv2_for-web`: `bc201497` → `6b526929`(7章)→(8章、本ドキュメント更新後にコミット)

## 現在の状態(Playwrightで動作確認済み)

`local.sawarachats.chat` で以下が一通りエラーなく動作することを確認済み:
- サインアップ・ログイン・サーバー作成
- ストレージ作成・編集(名前・容量上限変更)・削除
- ストレージエクスプローラーを開く、新規フォルダ作成
- フォルダの名前変更・移動(別フォルダの中への移動)・削除(配下含めて再帰削除、使用量も正しく減算)
- ファイルアップロード(ファイル選択 / ドラッグ&ドロップ)・ダウンロード・削除
- 容量表示バー: サーバー全体(サイドバー)・各ストレージ(サイドバー)・開いているストレージ単体(エクスプローラー)
- パストラバーサル(`../`)対策
- サーバーサイド検索(`GET /storage/:storageId/search?q=...`、ストレージ全体を再帰検索、パス付きで結果表示)
- インラインプレビュー(画像・動画・PDF・テキスト、`storage_preview` モーダル)

## 未実装・既知の課題(次にやること)

当初挙げていた6項目はすべて実装済み。次に着手するとしたら以下が候補(優先度・要否は要相談):

- i18nカタログの再生成(下記セクション参照)。`CreateStorage.tsx`・`EditStorage.tsx`・`DeleteStorage.tsx`・`SelectFolder.tsx` のラベルがハッシュ文字列で文字化けする既知バグ。
- `services/storage-api/node_modules` の `.gitignore` 整備(現状は誤ってgit管理されているが実害なし)。
- 検索パフォーマンス(大規模ストレージでの再帰検索の最適化、インデックス導入など)は初期実装では未対応。

## i18nカタログの既知バグ(未対応、別タスク推奨)

`<Trans>`/`t` macroを使っている箇所(`CreateStorage.tsx`・`EditStorage.tsx`・`DeleteStorage.tsx`・`SelectFolder.tsx` 等)は、lingui の翻訳カタログ(`packages/client/components/i18n/catalogs/`)が `lingui extract && lingui compile` で再生成されていないため、メッセージIDのハッシュ文字列(例: `fV3qzy`)がそのまま表示される。`ServerSidebar.tsx`/`StorageExplorer.tsx` は方針通り日本語をハードコードしているため影響を受けない。
直すには `packages/client` で `npx lingui extract && npx lingui compile` を実行する必要があるが、全ロケール・全コンポーネントに渡る大きな差分になるため、今回は対応していない。対応する場合は専用タスクとして切り出すことを推奨する(今回実装した新機能とは無関係の差分が混在しないように注意)。

## 作業の進め方について

- 何か変更したら、**必ず実機(ブラウザ)で動作確認すること**。上記「動作確認の定型フロー」を流用し、新機能の確認コードだけ追記する。
- 修正したら `BUGFIX_LOGIN_AND_STORAGE.md` に追記し、`SCv2_self-hosted` と `SCv2_for-web` 両方のリポジトリで個別にコミット・pushする(コミットメッセージは日本語、`fix:`/`feat:`/`docs:` プレフィックス)。
- `services/storage-api/node_modules` や、作業に関係ない既存の未コミット差分(`STORAGE_HANDOFF_P3.md`、`packages/solid-livekit-components` サブモジュール)はコミット対象に含めないこと。
- 動作確認用の一時スクリプト(`packages/client/e2e-manual/`)はコミットせず、確認後に削除すること。
