export type LibreOfficePhase = 'missing' | 'installing' | 'installed' | 'failed' | 'unsupported';

export type LibreOfficeRuntimeErrorCode =
  | 'LIBREOFFICE_RUNTIME_OFFLINE'
  | 'LIBREOFFICE_RUNTIME_CHECKSUM_MISMATCH'
  | 'LIBREOFFICE_RUNTIME_INSTALL_FAILED'
  | 'LIBREOFFICE_RUNTIME_UNSUPPORTED'
  | 'LIBREOFFICE_RUNTIME_FALLBACK';

export interface LibreOfficeRuntimeError {
  code: LibreOfficeRuntimeErrorCode;
  message: string;
  retryable: boolean;
  logPath: string;
}

export interface LibreOfficeReadyMarker {
  version: string;
  arch: 'arm64' | 'x86_64';
  sha256: string;
  sourceUrl: string;
  installedAt: string;
}

export interface LibreOfficeLookupOptions {
  dataDir?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  existsSync?: (targetPath: string) => boolean;
  which?: (binary: string) => string | null;
}

export interface LibreOfficeState {
  phase: LibreOfficePhase;
  root: string;
  sofficePath: string | null;
  error?: LibreOfficeRuntimeError;
  percent?: number;
}

export interface LibreOfficeProbeResult {
  url: string;
  ok: boolean;
  ttfbMs: number;
}

export interface EnsureLibreOfficeOptions extends LibreOfficeLookupOptions {
  arch?: string;
  probe?: (url: string, timeoutMs: number) => Promise<LibreOfficeProbeResult>;
  download?: (url: string, destination: string, totalBytes: number, onProgress: (transferred: number, total: number) => void) => Promise<void>;
  runCommand?: (file: string, args: string[]) => Promise<void>;
  now?: () => Date;
}

export type EnsureLibreOfficeResult =
  | { ok: true; sofficePath: string; reused: boolean; root: string }
  | { ok: false; error: LibreOfficeRuntimeError; root: string };
