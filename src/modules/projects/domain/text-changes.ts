import { createHash } from 'node:crypto';
import { PayloadTooLargeException, UnprocessableEntityException } from '@nestjs/common';
import { resourceExtensionMatches } from '../../files/domain/resource-file';

export const MAX_TEXT_BYTES = 1024 * 1024;
export const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
export const MAX_SNAPSHOT_FILES = 500;
export const MAX_SNAPSHOT_DIRECTORIES = 500;
export const MAX_CHANGE_OPERATIONS = 200;

export type TextChange =
  | { type: 'createDirectory'; path: string }
  | { type: 'renameDirectory'; path: string; newPath: string }
  | { type: 'deleteDirectory'; path: string }
  | { type: 'createFile'; path: string; content: string }
  | { type: 'updateText'; fileId: number; content: string }
  | { type: 'renameFile'; fileId: number; path: string }
  | { type: 'deleteFile'; fileId: number }
  | { type: 'setEntrypoint'; path: string }
  | { type: 'updateContext'; content: string }
  | { type: 'attachFile'; path: string; uploadId: number }
  | { type: 'replaceFile'; fileId: number; uploadId: number };

export interface UploadedDraftResource {
  blobId: number;
  sha256: string;
  sizeBytes: number;
  mediaType: string;
}

export interface DraftFile {
  fileId: number;
  path: string;
  blobId: number | null;
  contentKind: 'text' | 'binary';
  sha256: string;
  sizeBytes: number;
  mediaType: string;
  /** Present only for newly created or updated bytes. */
  content?: string;
  uploadId?: number;
}

export interface TextSnapshot {
  mainFileId: number;
  contextText: string;
  files: DraftFile[];
  directories?: string[];
}

function invalid(code: string, message: string): never {
  throw new UnprocessableEntityException({ code, message });
}

export function normalizedProjectPath(value: string): string {
  const path = value.normalize('NFC');
  const segments = path.split('/');
  if (
    !path ||
    Buffer.byteLength(path, 'utf8') > 1024 ||
    /[\\:\p{Cc}]/u.test(path) ||
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        Buffer.byteLength(segment, 'utf8') > 255 ||
        ['.git', '.typstoria'].includes(segment.toLowerCase()),
    ) ||
    Buffer.from(path, 'utf8').toString('utf8') !== path
  )
    invalid(
      'INVALID_FILE_PATH',
      'Use a relative POSIX path without reserved, empty or traversal segments',
    );
  return path;
}

export function validateText(content: string): void {
  if (content.includes('\0') || Buffer.from(content, 'utf8').toString('utf8') !== content)
    invalid('INVALID_TEXT', 'Text must be valid Unicode without NUL characters');
  if (Buffer.byteLength(content, 'utf8') > MAX_TEXT_BYTES)
    throw new PayloadTooLargeException({
      code: 'TEXT_TOO_LARGE',
      message: 'Each text file and context is limited to 1 MiB of UTF-8 bytes',
    });
}

function replaceText(file: DraftFile, content: string): void {
  validateText(content);
  file.content = content;
  file.blobId = null;
  file.sha256 = createHash('sha256').update(content, 'utf8').digest('hex');
  file.sizeBytes = Buffer.byteLength(content, 'utf8');
  file.mediaType = 'text/plain; charset=utf-8';
}

/** Build an immutable candidate in memory; validate the final tree before any storage writes. */
export function applyTextChanges(
  base: TextSnapshot,
  operations: readonly TextChange[],
  uploads: ReadonlyMap<number, UploadedDraftResource> = new Map(),
): TextSnapshot {
  const files = new Map(base.files.map((file) => [file.fileId, { ...file }]));
  const directories = new Set((base.directories ?? []).map(normalizedProjectPath));
  const inside = (value: string, directory: string) =>
    value === directory || value.startsWith(`${directory}/`);
  const directoryExists = (path: string) =>
    [...directories].some((value) => inside(value, path)) ||
    [...files.values()].some((file) => file.path.startsWith(`${path}/`));
  let nextTemporaryId = -1;
  let entrypointPath: string | undefined;
  let contextText = base.contextText;
  const existing = (fileId: number): DraftFile => {
    const file = files.get(fileId);
    if (!file)
      invalid(
        'FILE_NOT_IN_REVISION',
        'The target file does not belong to this revision or was already removed',
      );
    return file;
  };
  const resource = (uploadId: number): UploadedDraftResource => {
    const uploaded = uploads.get(uploadId);
    if (!uploaded) invalid('UPLOAD_NOT_AVAILABLE', 'The upload is not available for this project');
    return uploaded;
  };
  for (const operation of operations) {
    switch (operation.type) {
      case 'createDirectory':
        directories.add(normalizedProjectPath(operation.path));
        break;
      case 'renameDirectory': {
        const path = normalizedProjectPath(operation.path);
        const newPath = normalizedProjectPath(operation.newPath);
        if (!directoryExists(path))
          invalid('DIRECTORY_NOT_IN_REVISION', 'The directory does not exist');
        if (path === newPath) break;
        if (inside(newPath, path))
          invalid('INVALID_DIRECTORY_MOVE', 'A directory cannot be moved inside itself');
        if (directoryExists(newPath) || [...files.values()].some((file) => file.path === newPath))
          invalid('DIRECTORY_PATH_CONFLICT', 'The destination already exists');
        const move = (value: string) => normalizedProjectPath(newPath + value.slice(path.length));
        for (const file of files.values())
          if (file.path.startsWith(`${path}/`)) file.path = move(file.path);
        const moved = [...directories].map((value) => (inside(value, path) ? move(value) : value));
        directories.clear();
        for (const value of moved) directories.add(value);
        break;
      }
      case 'deleteDirectory': {
        const path = normalizedProjectPath(operation.path);
        if (!directoryExists(path))
          invalid('DIRECTORY_NOT_IN_REVISION', 'The directory does not exist');
        for (const [id, file] of files) if (file.path.startsWith(`${path}/`)) files.delete(id);
        for (const value of directories) if (inside(value, path)) directories.delete(value);
        break;
      }
      case 'createFile': {
        const file: DraftFile = {
          fileId: nextTemporaryId--,
          path: normalizedProjectPath(operation.path),
          blobId: null,
          contentKind: 'text',
          sha256: '',
          sizeBytes: 0,
          mediaType: 'text/plain; charset=utf-8',
        };
        replaceText(file, operation.content);
        files.set(file.fileId, file);
        break;
      }
      case 'updateText': {
        const file = existing(operation.fileId);
        if (file.contentKind !== 'text')
          invalid('NOT_A_TEXT_FILE', 'Binary files cannot be updated as text');
        replaceText(file, operation.content);
        break;
      }
      case 'renameFile':
        existing(operation.fileId).path = normalizedProjectPath(operation.path);
        break;
      case 'deleteFile':
        existing(operation.fileId);
        files.delete(operation.fileId);
        break;
      case 'setEntrypoint':
        entrypointPath = normalizedProjectPath(operation.path);
        break;
      case 'updateContext':
        validateText(operation.content);
        contextText = operation.content;
        break;
      case 'attachFile': {
        const file: DraftFile = {
          ...resource(operation.uploadId),
          fileId: nextTemporaryId--,
          path: normalizedProjectPath(operation.path),
          contentKind: 'binary',
          uploadId: operation.uploadId,
        };
        files.set(file.fileId, file);
        break;
      }
      case 'replaceFile': {
        const file = existing(operation.fileId);
        Object.assign(file, resource(operation.uploadId), {
          contentKind: 'binary',
          uploadId: operation.uploadId,
        });
        delete file.content;
        break;
      }
    }
  }
  const paths = new Set<string>();
  for (const file of files.values()) {
    if (file.contentKind === 'binary' && !resourceExtensionMatches(file.path, file.mediaType))
      invalid(
        'RESOURCE_EXTENSION_MISMATCH',
        'The final resource path must have an extension matching its detected format',
      );
    if (paths.has(file.path))
      invalid('DUPLICATE_FILE_PATH', 'The final tree contains duplicate file paths');
    paths.add(file.path);
  }
  for (const path of directories)
    if (paths.has(path))
      invalid('FILE_DIRECTORY_CONFLICT', 'A file path cannot also be a directory');
  for (const path of [...paths, ...directories]) {
    const segments = path.split('/');
    for (let index = 1; index < segments.length; index++)
      if (paths.has(segments.slice(0, index).join('/')))
        invalid('FILE_DIRECTORY_CONFLICT', 'A file path cannot also be a directory');
  }
  const mainFile =
    entrypointPath === undefined
      ? files.get(base.mainFileId)
      : [...files.values()].find((file) => file.path === entrypointPath);
  if (!mainFile || mainFile.contentKind !== 'text' || !mainFile.path.endsWith('.typ'))
    invalid(
      'ENTRYPOINT_REQUIRED',
      'The final tree must contain a text .typ entrypoint; select a replacement when deleting or changing it',
    );
  if (
    files.size > MAX_SNAPSHOT_FILES ||
    directories.size > MAX_SNAPSHOT_DIRECTORIES ||
    [...files.values()].reduce(
      (sum, file) => sum + file.sizeBytes,
      Buffer.byteLength(contextText, 'utf8'),
    ) > MAX_SNAPSHOT_BYTES
  )
    throw new PayloadTooLargeException({
      code: 'SNAPSHOT_TOO_LARGE',
      message:
        'A snapshot is limited to 500 files, 500 explicit directories and 64 MiB including context',
    });
  return {
    mainFileId: mainFile.fileId,
    contextText,
    files: [...files.values()],
    directories: [...directories].sort(),
  };
}
