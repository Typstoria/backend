/** Infrastructure boundary: the compiler only receives this attempt's immutable snapshot. */
export interface SandboxWorkspace {
  source: string;
  output: string;
  entrypoint: string;
  format?: 'pdf' | 'png';
}

export interface SandboxExecution {
  code: number | null;
  stderr: string;
  timedOut: boolean;
  outputLimit: boolean;
  resourceLimit?: boolean;
}

export interface TypstSandbox {
  fingerprint(): Promise<string>;
  execute(workspace: SandboxWorkspace, signal?: AbortSignal): Promise<SandboxExecution>;
}

export const SANDBOX_POLICY =
  '512MiB;1CPU;32tasks;30s;25MiBpdf;256KiBlogs;embedded-fonts;empty-packages;epoch0;short-diagnostics';

/** Both adapters use identical compiler inputs, flags and deterministic output policy. */
export function typstArguments(
  entrypoint: string,
  output = '/output/document.pdf',
  format: 'pdf' | 'png' = 'pdf',
): string[] {
  return [
    'compile',
    '--root',
    '/input',
    '--ignore-system-fonts',
    '--font-path',
    '/input',
    '--package-path',
    '/packages',
    '--package-cache-path',
    '/packages',
    '--creation-timestamp',
    '0',
    '--diagnostic-format',
    'short',
    '--jobs',
    '1',
    '--format',
    format,
    ...(format === 'png' ? ['--pages', '1', '--ppi', '72'] : []),
    `./${entrypoint}`,
    output,
  ];
}
