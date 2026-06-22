import unzipper from 'unzipper';
import { createWriteStream } from 'fs';
import { mkdir, rm } from 'fs/promises';
import { pipeline } from 'stream/promises';
import { Transform } from 'stream';
import path from 'path';

const MAX_ENTRIES = 100_000;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024 * 1024; // 10GB
// CUSTOM: アップロード元の接続が切れた/止まった場合に永久にハングさせないための上限
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
  // CUSTOM: macOSの「圧縮」機能(Finder右クリック)が自動生成するリソースフォーク用の
  // 隠しメタデータ。実体は元ファイルと同名で先頭に"._"が付いた小さなダミーファイルで、
  // 拡張子だけ見ると本物のjarと区別できないため、フォルダ名で丸ごと除外する。
  '__macosx',
]);

// CUSTOM: __MACOSXフォルダ外にも"._"接頭辞のAppleDoubleファイルが単体で残ることがあるため、
// ファイル名(パスの最後の要素)もチェックする。
function isAppleDoubleFile(entryPath: string): boolean {
  const basename = entryPath.split('/').pop() ?? '';
  return basename.startsWith('._');
}

export class ZipExtractError extends Error {}

export interface ExtractResult {
  // /dataからの相対パス(zip内のentry pathそのもの、'/'区切り)
  jarCandidates: string[];
}

/**
 * CUSTOM: アップロードされたファイルをdestRootと同じ階層の一時ファイルにストリーミングで
 * 保存する。サイズ上限超過・無通信(接続切れ)はここで検出して例外にする。
 * 戻り値は保存先パス。
 */
async function saveToTempFile(fileStream: NodeJS.ReadableStream, tempPath: string): Promise<void> {
  let totalBytes = 0;
  let timedOut = false;
  // CUSTOM: logs()と同じ理由でReadableStream型にはdestroy()が型上無いが実体には存在する
  const destroyableStream = fileStream as unknown as { destroy: (err?: Error) => void };

  let idleTimer: ReturnType<typeof setTimeout> = setTimeout(() => {}, 0);
  const bumpIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timedOut = true;
      destroyableStream.destroy(new Error('IDLE_TIMEOUT'));
    }, IDLE_TIMEOUT_MS);
  };
  bumpIdleTimer();

  const limitCheck = new Transform({
    transform(chunk: Buffer, _enc, callback) {
      totalBytes += chunk.length;
      bumpIdleTimer();
      if (totalBytes > MAX_TOTAL_BYTES) {
        callback(new ZipExtractError('アップロードされたファイルが上限(10GB)を超えています'));
        return;
      }
      callback(null, chunk);
    },
  });

  try {
    await pipeline(fileStream, limitCheck, createWriteStream(tempPath));
  } catch (err) {
    if (timedOut) {
      throw new ZipExtractError('アップロードが一定時間応答しなかったため中断しました');
    }
    throw err;
  } finally {
    clearTimeout(idleTimer);
  }
}

/**
 * zipストリームをdestRootへ展開しつつ、起動jarの候補を収集する。
 * CUSTOM: 当初はunzipper.Parse()でストリーミング展開していたが、macOSの「圧縮」機能が
 * 作るzip(__MACOSX配下のリソースフォーク用メタデータファイル)はデータディスクリプタ
 * 形式(ローカルファイルヘッダのサイズが0で、実サイズは後続のディスクリプタに書かれる)を
 * 使い、unzipper.Parse()のストリーミング解析がentry境界を見失って
 * "invalid signature"/"unexpected end of file"を起こすことが実機検証で判明した
 * (実際の参考サーバーzipで再現済み)。central directory(zip末尾の正式な目次)を
 * 読む unzipper.Open.file() + directory.extract() はサイズを目次から正しく取得するため
 * この問題が起きない。central directoryはランダムアクセス(seek)が必要なため、
 * アップロードされたファイルを一旦同じディスク上の一時ファイルに書き出してから開く。
 */
export async function extractZipStream(
  fileStream: NodeJS.ReadableStream,
  destRoot: string,
): Promise<ExtractResult> {
  const tempZipPath = `${destRoot}.upload.zip`;
  await mkdir(path.dirname(destRoot), { recursive: true });

  try {
    await saveToTempFile(fileStream, tempZipPath);

    let directory: unzipper.CentralDirectory;
    try {
      directory = await unzipper.Open.file(tempZipPath);
    } catch (err) {
      throw new ZipExtractError(`zipファイルとして読み込めませんでした: ${(err as Error).message}`);
    }

    if (directory.files.length > MAX_ENTRIES) {
      throw new ZipExtractError(`zip内のファイル数が上限(${MAX_ENTRIES}件)を超えています`);
    }

    const totalUncompressedBytes = directory.files.reduce((sum, f) => sum + (f.uncompressedSize ?? 0), 0);
    if (totalUncompressedBytes > MAX_TOTAL_BYTES) {
      throw new ZipExtractError('展開後の合計サイズが上限(10GB)を超えています');
    }

    // CUSTOM: directory.extract()自身もzip-slip対策(destRoot外への書き込みを黒く無視)を
    // 持っているが、無視するだけでエラーにならない。不正なzipは黒く一部スキップするのではなく
    // 明示的に拒否したいので、抽出前に自分でも検証する。
    const resolvedRoot = path.resolve(destRoot);
    for (const file of directory.files) {
      const resolved = path.resolve(resolvedRoot, file.path);
      if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
        throw new ZipExtractError(`不正なパスを含むzipです: ${file.path}`);
      }
    }

    const jarCandidates: string[] = [];
    for (const file of directory.files) {
      if (file.type === 'Directory') continue;
      const lower = file.path.toLowerCase();
      if (!lower.endsWith('.jar')) continue;
      const segments = file.path.split('/').map((s) => s.toLowerCase());
      if (segments.some((seg) => EXCLUDED_DIR_SEGMENTS.has(seg))) continue;
      if (isAppleDoubleFile(file.path)) continue;
      jarCandidates.push(file.path);
    }

    await mkdir(destRoot, { recursive: true });
    await directory.extract({ path: destRoot, concurrency: 4 });

    return { jarCandidates };
  } finally {
    await rm(tempZipPath, { force: true });
  }
}

export async function removeExtractedDir(destRoot: string): Promise<void> {
  await rm(destRoot, { recursive: true, force: true });
}
