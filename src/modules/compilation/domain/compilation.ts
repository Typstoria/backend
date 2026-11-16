export type CompileStatus =
  'queued' | 'running' | 'succeeded' | 'failed' | 'timed_out' | 'cancelled';
export type CompileErrorCode =
  | 'TYPST_ERROR'
  | 'DEPENDENCY_UNAVAILABLE'
  | 'RUNNER_UNAVAILABLE'
  | 'STORAGE_UNAVAILABLE'
  | 'OUTPUT_LIMIT'
  | 'RESOURCE_LIMIT'
  | 'INTERNAL_ERROR'
  | 'ACCESS_REVOKED'
  | 'WORKER_LOST';

export interface CompileDiagnostic {
  fileId: number | null;
  path: string | null;
  severity: 'error' | 'warning';
  message: string;
  range: null;
}

export interface CompileInputFile {
  fileId: number;
  path: string;
  content: Buffer;
}

export interface CompileInput {
  mainFileId: number;
  files: CompileInputFile[];
}

export interface CompileResult {
  status: 'succeeded' | 'failed' | 'timed_out';
  errorCode: CompileErrorCode | null;
  diagnostics: CompileDiagnostic[];
  compilerFingerprint: string;
  pdf?: Buffer;
}

export const COMPILE_LEASE_MS = 90_000;
export const COMPILE_ATTEMPTS = 3;
export const MAX_PDF_BYTES = 25 * 1024 * 1024;
export const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
export const MAX_PREVIEW_DIMENSION = 4096;
export const MAX_PREVIEW_PIXELS = 8_000_000;
export const ARTIFACT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export abstract class TypstRunner {
  abstract compile(input: CompileInput, signal?: AbortSignal): Promise<CompileResult>;

  async preview(_input: CompileInput, _signal?: AbortSignal): Promise<Buffer> {
    throw new Error('Preview is not supported by this Typst runner');
  }
}
