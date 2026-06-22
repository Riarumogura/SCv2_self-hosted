import unzipper from 'unzipper';
import { createWriteStream } from 'fs';
import { mkdir, rm } from 'fs/promises';
import { pipeline } from 'stream/promises';
import path from 'path';

const MAX_ENTRIES = 100_000;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024 * 1024; // 10GB
// CUSTOM: アップロード元の接続が切れた/止まった場合に展開処理を永久にハングさせず、
// 展開済みデータを後始末してエラーを返せるようにする上限(無通信が続いた時間)
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

// CUSTOM: このフォルダ名を含むjarは起動候補から除外する(MOD本体やライブラリ、
// インストーラーが残した一時ファイル等を「起動すべきサーバーjar」と誤認しないため)。
const EXCLUDED_DIR_SEGMENTS = new Set([
  'mods',
  'libraries',
  'config',
  'cache',
  'logs',
  'crash-reports',
  'schematics',
]);

export class ZipExtractError extends Error {}

export interface ExtractResult {
  // /dataからの相対パス(zip内のentry pathそのもの、'/'区切り)
  jarCandidates: string[];
}

/**
 * zipストリームをdestRootへ展開しつつ、起動jarの候補を収集する。
 * CUSTOM: 各entryのパスはdestRoot配下に収まることを検証してから書き出す
 * (zip-slip対策)。展開後合計サイズ・entry数が上限を超えたら例外を投げて中断する。
 * 呼び出し側は例外時にdestRootを削除すること(このサービスは部分展開済みデータの
 * 後始末をしない)。
 */
export function extractZipStream(
  fileStream: NodeJS.ReadableStream,
  destRoot: string,
): Promise<ExtractResult> {
  return new Promise((resolve, reject) => {
    let entryCount = 0;
    let totalBytes = 0;
    const jarCandidates: string[] = [];
    // CUSTOM: 各entryのmkdir/pipelineは非同期で進むため、zipStreamの'close'
    // (=入力バイトの読み取り完了)はentry単位の書き込み完了を保証しない。
    // すべてのentry処理Promiseをここに集め、'close'発火後にPromise.allで
    // 完了を待ってから初めてresolveする(さもないと最後のentryの書き込み中に
    // jarCandidatesが未反映のまま返ってしまうレースが起こる)。
    const pendingWrites: Promise<void>[] = [];
    let settled = false;

    const bumpIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        fail(new ZipExtractError('アップロードが一定時間応答しなかったため中断しました'));
      }, IDLE_TIMEOUT_MS);
    };

    // CUSTOM: settledになった後もこの関数自体は呼べる状態を保つ(下のerrorハンドラを
    // 参照)。実際の後始末はsettled済みなら何もしない。
    const fail = (error: Error) => {
      clearTimeout(idleTimer);
      if (settled) return;
      settled = true;
      // CUSTOM: ここでremoveAllListeners()してはいけない。zipはentryごとに
      // 独立したzlib inflateストリームを持ち、複数entryが並行処理中に2つ目以降の
      // entryが少し遅れて別個に'error'を出すことがある(実際のサーバーzipのように
      // entry数が多い場合に発生しやすい)。先にリスナーを外すと、その2つ目の'error'は
      // 受け手が誰もいないままNode側に渡り、プロセス全体がuncaughtExceptionで
      // 落ちる(本機能で実際に発生した障害の原因)。settledフラグのチェックだけで
      // 重複処理を防ぎ、リスナー自体は最後まで残しておく。
      zipStream.destroy();
      reject(error);
    };

    // CUSTOM: forceStream:trueを付けると'entry'イベントが発火しなくなる(unzipper側の
    // 既知の挙動。動作確認の結果、無指定の方がドキュメント通りentryイベントベースで動く)
    const zipStream = fileStream.pipe(unzipper.Parse());
    let idleTimer = setTimeout(() => {}, 0);
    bumpIdleTimer();

    zipStream.on('entry', (entry: unzipper.Entry) => {
      bumpIdleTimer();

      // CUSTOM: entry自身が後段(zlib inflate等)からのエラーで destroy された場合に
      // 備えて、必ずこのentry専用のerrorリスナーを付けておく(上のfail()の説明と同じ理由)。
      entry.on('error', (err: Error) => {
        if (!settled) fail(new ZipExtractError(`zipの展開に失敗しました: ${err.message}`));
      });

      if (settled) {
        entry.autodrain();
        return;
      }

      entryCount += 1;
      if (entryCount > MAX_ENTRIES) {
        entry.autodrain();
        fail(new ZipExtractError(`zip内のファイル数が上限(${MAX_ENTRIES}件)を超えています`));
        return;
      }

      const entryPath = entry.path;
      const safePath = path.resolve(destRoot, entryPath);
      if (safePath !== destRoot && !safePath.startsWith(destRoot + path.sep)) {
        entry.autodrain();
        fail(new ZipExtractError(`不正なパスを含むzipです: ${entryPath}`));
        return;
      }

      if (entry.type === 'Directory') {
        pendingWrites.push(
          mkdir(safePath, { recursive: true })
            .then(() => {
              entry.autodrain();
            })
            .catch((err) => fail(new ZipExtractError(`フォルダの作成に失敗しました: ${err.message}`))),
        );
        return;
      }

      // CUSTOM: unzipper.Parse()はバックプレッシャーを保ち、現在のentryが消費し終わるまで
      // 次のentryイベントを発火しないため、ここでpause/resumeを手動操作する必要はない。
      const writeDone = (async () => {
        await mkdir(path.dirname(safePath), { recursive: true });

        const writeStream = createWriteStream(safePath);
        entry.on('data', (chunk: Buffer) => {
          bumpIdleTimer();
          totalBytes += chunk.length;
          if (totalBytes > MAX_TOTAL_BYTES) {
            fail(new ZipExtractError('展開後の合計サイズが上限(10GB)を超えています'));
            entry.unpipe();
            entry.destroy();
          }
        });

        await pipeline(entry, writeStream);

        const lower = entryPath.toLowerCase();
        if (lower.endsWith('.jar')) {
          const segments = entryPath.split('/').map((s) => s.toLowerCase());
          const isExcluded = segments.some((seg) => EXCLUDED_DIR_SEGMENTS.has(seg));
          if (!isExcluded) {
            jarCandidates.push(entryPath);
          }
        }
      })().catch((err) => {
        if (!settled) fail(new ZipExtractError(`zipの展開に失敗しました: ${err.message}`));
      });

      pendingWrites.push(writeDone);
    });

    zipStream.on('error', (err) => fail(new ZipExtractError(`zipの読み込みに失敗しました: ${err.message}`)));

    zipStream.on('close', () => {
      clearTimeout(idleTimer);
      if (settled) return;
      settled = true;
      Promise.all(pendingWrites).then(() => resolve({ jarCandidates }));
    });
  });
}

export async function removeExtractedDir(destRoot: string): Promise<void> {
  await rm(destRoot, { recursive: true, force: true });
}
