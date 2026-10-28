import {
  applyTextChanges,
  MAX_SNAPSHOT_BYTES,
  MAX_TEXT_BYTES,
  normalizedProjectPath,
  validateText,
} from './text-changes';
import type { TextSnapshot, TextChange } from './text-changes';
import { mutationPayloadHash } from './idempotency';

const base = (): TextSnapshot => ({
  mainFileId: 1,
  contextText: '',
  files: [
    {
      fileId: 1,
      path: 'main.typ',
      blobId: 1,
      contentKind: 'text',
      sha256: 'a'.repeat(64),
      sizeBytes: 0,
      mediaType: 'text/plain; charset=utf-8',
    },
  ],
});

it.each([
  '/etc/passwd',
  '../secret',
  'a/../b.typ',
  'a/./b.typ',
  'a//b.typ',
  'a/',
  'C:/x.typ',
  '\\server\\share',
  '.git/config',
  'x/.GIT/config',
  '.typstoria/manifest',
  'bad\0.typ',
  'bad\n.typ',
  '\ud800.typ',
  'x'.repeat(256),
])('rejects unsafe or ambiguous file paths: %j', (path) => {
  expect(() => normalizedProjectPath(path)).toThrow();
});

it('normalizes Unicode paths once and detects resulting collisions', () => {
  expect(normalizedProjectPath('cafe\u0301.typ')).toBe('café.typ');
  expect(() =>
    applyTextChanges(base(), [
      { type: 'createFile', path: 'cafe\u0301.typ', content: '' },
      { type: 'createFile', path: 'café.typ', content: '' },
    ]),
  ).toThrow('duplicate file paths');
});

it('supports final-tree path swaps and preserves original file IDs and the base snapshot', () => {
  const original = base();
  original.files.push({ ...original.files[0]!, fileId: 2, path: 'chapter.typ' });
  const draft = applyTextChanges(original, [
    { type: 'renameFile', fileId: 1, path: 'chapter.typ' },
    { type: 'renameFile', fileId: 2, path: 'main.typ' },
  ]);
  expect(draft.files.map((file) => [file.fileId, file.path])).toEqual([
    [1, 'chapter.typ'],
    [2, 'main.typ'],
  ]);
  expect(draft.mainFileId).toBe(1);
  expect(original.files[0]!.path).toBe('main.typ');
});

it('validates the final entrypoint and file/directory structure', () => {
  expect(() => applyTextChanges(base(), [{ type: 'deleteFile', fileId: 1 }])).toThrow('entrypoint');
  expect(() =>
    applyTextChanges(base(), [{ type: 'renameFile', fileId: 1, path: 'main.txt' }]),
  ).toThrow('entrypoint');
  expect(() =>
    applyTextChanges(base(), [{ type: 'createFile', path: 'main.typ/chapter.typ', content: '' }]),
  ).toThrow('directory');
  const changed = applyTextChanges(base(), [
    { type: 'deleteFile', fileId: 1 },
    { type: 'setEntrypoint', path: 'new.typ' },
    { type: 'createFile', path: 'new.typ', content: '#broken(' },
  ]);
  expect(changed.files).toHaveLength(1);
  expect(changed.mainFileId).toBe(changed.files[0]!.fileId);
  expect(changed.files[0]!.content).toBe('#broken(');
});

it('rejects missing/deleted file targets and text writes to binary files', () => {
  expect(() => applyTextChanges(base(), [{ type: 'updateText', fileId: 9, content: '' }])).toThrow(
    'target file',
  );
  expect(() =>
    applyTextChanges(base(), [
      { type: 'deleteFile', fileId: 1 },
      { type: 'renameFile', fileId: 1, path: 'x.typ' },
    ]),
  ).toThrow('target file');
  const binary = base();
  binary.files.push({ ...binary.files[0]!, fileId: 2, path: 'image.png', contentKind: 'binary' });
  expect(() => applyTextChanges(binary, [{ type: 'updateText', fileId: 2, content: 'x' }])).toThrow(
    'Binary',
  );
});

it('measures text and snapshot quotas in UTF-8 bytes and rejects invalid Unicode/NUL', () => {
  expect(() => validateText('я'.repeat(MAX_TEXT_BYTES / 2))).not.toThrow();
  expect(() => validateText('я'.repeat(MAX_TEXT_BYTES / 2 + 1))).toThrow('1 MiB');
  expect(() => validateText('\ud800')).toThrow('Unicode');
  expect(() => validateText('\0')).toThrow('Unicode');
  const large = base();
  large.files[0]!.sizeBytes = MAX_SNAPSHOT_BYTES;
  expect(() => applyTextChanges(large, [{ type: 'updateContext', content: 'x' }])).toThrow(
    '64 MiB',
  );
  const many = base();
  many.files = Array.from({ length: 500 }, (_, index) => ({
    ...base().files[0]!,
    fileId: index + 1,
    path: index === 0 ? 'main.typ' : `${index}.typ`,
  }));
  expect(() => applyTextChanges(many, [{ type: 'updateContext', content: '' }])).not.toThrow();
  expect(() =>
    applyTextChanges(many, [{ type: 'createFile', path: 'extra.typ', content: '' }]),
  ).toThrow('500 files');
});

it('hashes payloads independently of JSON object property order, retaining operation order', () => {
  const operations: TextChange[] = [
    { type: 'updateText', fileId: 1, content: 'abc' },
    { type: 'updateContext', content: '' },
  ];
  expect(mutationPayloadHash({ baseRevisionId: 1, operations })).toBe(
    mutationPayloadHash({
      operations: [
        { content: 'abc', fileId: 1, type: 'updateText' },
        { content: '', type: 'updateContext' },
      ],
      baseRevisionId: 1,
    }),
  );
  expect(mutationPayloadHash({ operations })).not.toBe(
    mutationPayloadHash({ operations: [...operations].reverse() }),
  );
});
