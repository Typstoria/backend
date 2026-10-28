import { createHash } from 'node:crypto';

interface ManifestFile {
  fileId: number;
  path: string;
  contentKind: 'text' | 'binary';
  sha256: string;
  sizeBytes: number;
  mediaType: string;
}

/** Versioned canonical serialization, independent of query order and object property order. */
export function serializeSnapshotManifest(input: {
  mainFileId: number;
  contextText: string;
  files: readonly ManifestFile[];
}): string {
  const files = [...input.files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => ({
      fileId: file.fileId,
      path: file.path,
      contentKind: file.contentKind,
      sha256: file.sha256,
      sizeBytes: file.sizeBytes,
      mediaType: file.mediaType,
    }));
  const manifest = {
    version: 1,
    mainFileId: input.mainFileId,
    contextText: input.contextText,
    files,
    materials: [],
  };
  return JSON.stringify(manifest);
}

export function snapshotManifestHash(
  input: Parameters<typeof serializeSnapshotManifest>[0],
): string {
  return createHash('sha256').update(serializeSnapshotManifest(input), 'utf8').digest('hex');
}
