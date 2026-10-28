import { typstDiagnostics } from './typst-diagnostics';

it('maps only snapshot paths and redacts absolute host paths without guessing UTF-16 positions', () => {
  const files = [{ fileId: 7, path: 'src/головний.typ', content: Buffer.from('Текст 😀') }];
  expect(
    typstDiagnostics(
      '/input/src/головний.typ:1:8: error: cannot read "/home/owner/secret"\nwarning: optional font unavailable\n/home/private.typ:2:1: error: hidden',
      files,
    ),
  ).toEqual([
    {
      fileId: 7,
      path: 'src/головний.typ',
      severity: 'error',
      message: 'cannot read "[private path]"',
      range: null,
    },
    {
      fileId: null,
      path: null,
      severity: 'warning',
      message: 'optional font unavailable',
      range: null,
    },
    { fileId: null, path: null, severity: 'error', message: 'hidden', range: null },
  ]);
});

it('bounds diagnostic count and message size', () => {
  const result = typstDiagnostics(
    Array.from({ length: 101 }, () => `error: ${'x'.repeat(3000)}`).join('\n'),
    [],
  );
  expect(result).toHaveLength(100);
  expect(result[0]!.message).toHaveLength(2000);
});
