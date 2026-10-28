import type { CompileDiagnostic, CompileInputFile } from '../domain/compilation';

export function typstDiagnostics(
  stderr: string,
  files: readonly CompileInputFile[],
): CompileDiagnostic[] {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const diagnostics: CompileDiagnostic[] = [];
  for (const line of stderr.split('\n')) {
    const match = /^(?:(.*?):\d+:\d+: )?(error|warning): (.*)$/.exec(line);
    if (!match) continue;
    const path = match[1]?.replace(/^\/input\//, '');
    const file = path ? byPath.get(path) : undefined;
    const message = match[3]!
      .replace(/(^|[\s"'(])\/[^\s"'<>),;]+/g, '$1[private path]')
      .slice(0, 2000);
    diagnostics.push({
      fileId: file?.fileId ?? null,
      path: file?.path ?? null,
      severity: match[2] as 'error' | 'warning',
      message,
      range: null,
    });
    if (diagnostics.length === 100) break;
  }
  return diagnostics;
}
