import unzipper from 'unzipper';
import { createWriteStream } from 'fs';
import { mkdir, rm, readdir, rename } from 'fs/promises';
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

// CUSTOM: インストーラーjar(forge-x.x.x-installer.jar等)はGUI/CLIのセットアップ実行用で、
// 専用サーバーとしてそのまま起動できるjarではないため、候補として一度も表示しない。
function isInstallerJar(entryPath: string): boolean {
  const basename = entryPath.split('/').pop() ?? '';
  return /installer/i.test(basename);
}

// CUSTOM: Mojang配布の無加工バニラサーバーjar(minecraft_server.<version>.jar / server.jar)。
// Forge等のMod用jarと一緒にzipへ含まれていることがあるが、Modワールドをこのjarで起動すると
// サーバーが認識しないMod由来のブロック/エンティティが次回保存時に失われ、Forgeで開き直しても
// 復元できなくなる(実際にユーザーがこの被害を受けた)。他に候補がある場合は除外し、
// 本当にバニラサーバーでこれしか無い場合だけ残す。
function isVanillaServerJar(entryPath: string): boolean {
  const basename = (entryPath.split('/').pop() ?? '').toLowerCase();
  return /^minecraft_server[\d.]*\.jar$/.test(basename) || basename === 'server.jar';
}

/**
 * CUSTOM: zipを「フォルダを右クリックして圧縮」して作った場合、zip内の全ファイルが
 * そのフォルダ名の単一ラップフォルダの中に入る(例: Forge1.12.2SurvivalServer/world/...)。
 * このまま展開するとitzgイメージ・Minecraft本体が期待する/data/world等のパスと
 * 1階層ズレてしまい、既存のworld/mods/プレイヤーデータ等を読み込めず新規生成してしまう
 * (実際のユーザーのzipで確認・再現済みの不具合)。destRoot直下が「ディレクトリ1つだけ」
 * (__MACOSXを除く)の場合に限り、その中身をdestRoot直下へ展開し直す。複数のファイル/
 * フォルダが直下にある場合(=zipのルートに直接ファイル群を圧縮した一般的なケース)は
 * 平坦化しない。戻り値は平坦化したラップフォルダ名(平坦化しなかった場合はnull)。
 */
export async function flattenSingleWrapperDir(destRoot: string): Promise<string | null> {
  await rm(path.join(destRoot, '__MACOSX'), { recursive: true, force: true });

  const entries = await readdir(destRoot, { withFileTypes: true });
  if (entries.length !== 1 || !entries[0].isDirectory()) {
    return null;
  }

  const wrapperName = entries[0].name;
  const wrapperPath = path.join(destRoot, wrapperName);
  const children = await readdir(wrapperPath);
  for (const child of children) {
    await rename(path.join(wrapperPath, child), path.join(destRoot, child));
  }
  await rm(wrapperPath, { recursive: true, force: true });
  return wrapperName;
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
 * CUSTOM: zipアップロードの共通コア処理(一時ファイル保存→central directory読み込み→
 * 検証→展開→単一ラップフォルダの平坦化)。サーバー新規作成時のzipアップロードと、
 * ファイルマネージャーからのフォルダ一括置換えzipアップロードの両方で使う。
 * 戻り値はcentral directoryのfiles一覧(平坦化前の元パス)とラップフォルダ名
 * (起動jar候補の算出など、呼び出し側でパス調整が必要な場合に使う)。
 */
async function extractZipToDirectory(
  fileStream: NodeJS.ReadableStream,
  destRoot: string,
): Promise<{ files: unzipper.File[]; wrapperName: string | null }> {
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

    await mkdir(destRoot, { recursive: true });
    await directory.extract({ path: destRoot, concurrency: 4 });

    const wrapperName = await flattenSingleWrapperDir(destRoot);

    return { files: directory.files, wrapperName };
  } finally {
    await rm(tempZipPath, { force: true });
  }
}

/**
 * zipストリームをdestRootへ展開しつつ、起動jarの候補を収集する(サーバー新規作成用)。
 * CUSTOM: 当初はunzipper.Parse()でストリーミング展開していたが、macOSの「圧縮」機能が
 * 作るzip(__MACOSX配下のリソースフォーク用メタデータファイル)はデータディスクリプタ
 * 形式(ローカルファイルヘッダのサイズが0で、実サイズは後続のディスクリプタに書かれる)を
 * 使い、unzipper.Parse()のストリーミング解析がentry境界を見失って
 * "invalid signature"/"unexpected end of file"を起こすことが実機検証で判明した
 * (実際の参考サーバーzipで再現済み)。central directory(zip末尾の正式な目次)を
 * 読む unzipper.Open.file() + directory.extract() はサイズを目次から正しく取得するため
 * この問題が起きない。
 */
export async function extractZipStream(
  fileStream: NodeJS.ReadableStream,
  destRoot: string,
): Promise<ExtractResult> {
  const { files, wrapperName } = await extractZipToDirectory(fileStream, destRoot);

  const rawJarCandidates: string[] = [];
  for (const file of files) {
    if (file.type === 'Directory') continue;
    const lower = file.path.toLowerCase();
    if (!lower.endsWith('.jar')) continue;
    const segments = file.path.split('/').map((s) => s.toLowerCase());
    if (segments.some((seg) => EXCLUDED_DIR_SEGMENTS.has(seg))) continue;
    if (isAppleDoubleFile(file.path)) continue;
    if (isInstallerJar(file.path)) continue;
    rawJarCandidates.push(file.path);
  }

  // CUSTOM: Mod用jarが他にもある場合はバニラjarを候補から除外する(isVanillaServerJarの説明参照)。
  const nonVanillaCandidates = rawJarCandidates.filter((p) => !isVanillaServerJar(p));
  const jarCandidates = nonVanillaCandidates.length > 0 ? nonVanillaCandidates : rawJarCandidates;

  const adjustedJarCandidates = wrapperName
    ? jarCandidates.map((p) =>
        p === wrapperName || p.startsWith(`${wrapperName}/`) ? p.slice(wrapperName.length + 1) : p,
      )
    : jarCandidates;

  return { jarCandidates: adjustedJarCandidates };
}

/**
 * CUSTOM: ファイルマネージャーの「zipをアップロードして指定フォルダへ展開」機能用。
 * targetDir(例: data/minecraft/{mcId}/world)の既存内容を削除してからzipの内容で
 * 置き換える。サーバー新規作成時と同じ展開コア処理(central directory方式+
 * 単一ラップフォルダの平坦化)を再利用する。
 */
export async function extractZipToFolderReplacing(
  fileStream: NodeJS.ReadableStream,
  targetDir: string,
): Promise<void> {
  await rm(targetDir, { recursive: true, force: true });
  await extractZipToDirectory(fileStream, targetDir);
}

export async function removeExtractedDir(destRoot: string): Promise<void> {
  await rm(destRoot, { recursive: true, force: true });
}
