import { snapshotManifestHash } from './snapshot-manifest';

it('hashes the complete snapshot canonically regardless of file and property order', () => {
  const main = {
    fileId: 1,
    path: 'main.typ',
    contentKind: 'text' as const,
    sha256: 'a'.repeat(64),
    sizeBytes: 0,
    mediaType: 'text/plain',
  };
  const chapter = { ...main, fileId: 2, path: 'chapter.typ' };
  const input = { mainFileId: 1, contextText: '', files: [main, chapter] };
  const hash = snapshotManifestHash(input);
  expect(hash).toMatch(/^[0-9a-f]{64}$/);
  expect(
    snapshotManifestHash({
      ...input,
      files: [
        chapter,
        {
          mediaType: main.mediaType,
          sizeBytes: main.sizeBytes,
          sha256: main.sha256,
          contentKind: main.contentKind,
          path: main.path,
          fileId: main.fileId,
        },
      ],
    }),
  ).toBe(hash);
  expect(snapshotManifestHash({ ...input, contextText: 'Новий контекст' })).not.toBe(hash);
  expect(snapshotManifestHash({ ...input, mainFileId: 2 })).not.toBe(hash);
  expect(
    snapshotManifestHash({ ...input, files: [{ ...main, path: 'renamed.typ' }, chapter] }),
  ).not.toBe(hash);
  expect(
    snapshotManifestHash({ ...input, files: [{ ...main, sha256: 'b'.repeat(64) }, chapter] }),
  ).not.toBe(hash);
});
