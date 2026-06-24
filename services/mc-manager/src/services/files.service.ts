import { promises as fs, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import path from 'path';
import { config } from '../config';

const TEXT_FILE_MAX_BYTES = 2 * 1024 * 1024; // 2MB

export class FileOpError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

export interface FileEntry {
  name: string;
  type: 'file' | 'folder';
  size: number;
  lastModified: string;
}

function serverRoot(mcId: string): string {
  return path.join(config.mcDataRoot, mcId);
}

/**
 * CUSTOM: storage-apiのsanitizePath()(./../空セグメントの除去)と同じ考え方に加え、
 * path.resolveでサーバーのルート配下に収まることも検証する(zip-extract.service.tsの
 * zip-slip対策と同じ二重防御)。ユーザー入力のpathは必ずこれを通してから使うこと。
 */
export function resolveSafePath(mcId: string, relativePath: string | undefined): string {
  const root = serverRoot(mcId);
  const cleaned = (relativePath ?? '')
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s && s !== '.' && s !== '..')
    .join('/');
  const resolved = path.resolve(root, cleaned);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new FileOpError('不正なパスです');
  }
  return resolved;
}

export async function listEntries(mcId: string, relativePath: string | undefined): Promise<FileEntry[]> {
  const dirPath = resolveSafePath(mcId, relativePath);
  let dirents;
  try {
    dirents = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    throw new FileOpError('フォルダが見つかりません', 404);
  }

  const entries: FileEntry[] = [];
  for (const dirent of dirents) {
    const stat = await fs.stat(path.join(dirPath, dirent.name)).catch(() => null);
    entries.push({
      name: dirent.name,
      type: dirent.isDirectory() ? 'folder' : 'file',
      size: stat?.size ?? 0,
      lastModified: (stat?.mtime ?? new Date()).toISOString(),
    });
  }
  return entries;
}

export async function readTextFile(mcId: string, relativePath: string): Promise<string> {
  const filePath = resolveSafePath(mcId, relativePath);
  const stat = await fs.stat(filePath).catch(() => {
    throw new FileOpError('ファイルが見つかりません', 404);
  });
  if (stat.isDirectory()) throw new FileOpError('フォルダはテキストとして読み込めません');
  if (stat.size > TEXT_FILE_MAX_BYTES) {
    throw new FileOpError('ファイルサイズが上限(2MB)を超えているためテキスト編集できません');
  }
  return fs.readFile(filePath, 'utf-8');
}

// CUSTOM: world(world_nether/world_the_end等のDIM相当フォルダもworldで始まるので含む)・
// mods・plugins・server.propertiesの「トップレベルそのもの」への変更系操作の前は
// 1世代だけバックアップを残す。ネストした個別ファイルへの操作までは対象にしない
// (例: world/level.datの編集ではバックアップしない。world全体の削除/置換えのみ)。
function backupCategoryFor(relativePath: string): string | null {
  const segments = relativePath.split('/').filter(Boolean);
  if (segments.length !== 1) return null;
  const name = segments[0];
  const lower = name.toLowerCase();
  if (lower === 'server.properties') return name;
  if (lower.startsWith('world')) return name;
  if (lower === 'mods' || lower === 'plugins') return name;
  return null;
}

async function backupIfSensitive(mcId: string, relativePath: string): Promise<void> {
  const category = backupCategoryFor(relativePath);
  if (!category) return;

  const root = serverRoot(mcId);
  const sourcePath = path.join(root, category);
  const exists = await fs
    .access(sourcePath)
    .then(() => true)
    .catch(() => false);
  if (!exists) return;

  const backupPath = path.join(root, '.backups', category);
  await fs.rm(backupPath, { recursive: true, force: true });
  await fs.mkdir(path.dirname(backupPath), { recursive: true });
  await fs.cp(sourcePath, backupPath, { recursive: true });
}

export async function writeTextFile(mcId: string, relativePath: string, content: string): Promise<void> {
  if (Buffer.byteLength(content, 'utf-8') > TEXT_FILE_MAX_BYTES) {
    throw new FileOpError('保存するテキストが上限(2MB)を超えています');
  }
  const filePath = resolveSafePath(mcId, relativePath);
  await backupIfSensitive(mcId, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
}

export async function deleteEntry(mcId: string, relativePath: string): Promise<void> {
  const targetPath = resolveSafePath(mcId, relativePath);
  await backupIfSensitive(mcId, relativePath);
  await fs.rm(targetPath, { recursive: true, force: true });
}

export async function createFolder(mcId: string, relativePath: string): Promise<void> {
  const dirPath = resolveSafePath(mcId, relativePath);
  await fs.mkdir(dirPath, { recursive: true });
}

export async function renameEntry(mcId: string, relativePath: string, newRelativePath: string): Promise<void> {
  const oldPath = resolveSafePath(mcId, relativePath);
  const newPath = resolveSafePath(mcId, newRelativePath);
  await backupIfSensitive(mcId, relativePath);
  await fs.mkdir(path.dirname(newPath), { recursive: true });
  await fs.rename(oldPath, newPath);
}

export async function saveUploadedFile(
  mcId: string,
  relativePath: string,
  fileStream: NodeJS.ReadableStream,
): Promise<void> {
  const filePath = resolveSafePath(mcId, relativePath);
  await backupIfSensitive(mcId, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await pipeline(fileStream, createWriteStream(filePath));
}

/**
 * CUSTOM: zipをフォルダへ一括展開する前のバックアップ。
 * (extractZipToFolderReplacing自体はバックアップを知らない汎用関数のため、呼び出し側で行う)。
 */
export async function backupFolderBeforeReplace(mcId: string, relativePath: string): Promise<void> {
  await backupIfSensitive(mcId, relativePath);
}

export function resolveServerPath(mcId: string, relativePath: string): string {
  return resolveSafePath(mcId, relativePath);
}
