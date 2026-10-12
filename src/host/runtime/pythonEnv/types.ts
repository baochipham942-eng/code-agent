export type PythonEnvPhase = 'missing' | 'installing' | 'installed' | 'failed' | 'unsupported';

export type PythonRuntimeErrorCode =
  | 'PYTHON_RUNTIME_OFFLINE'
  | 'PYTHON_RUNTIME_INSTALL_FAILED'
  | 'PYTHON_RUNTIME_UNSUPPORTED';

export interface PythonRuntimeError {
  code: PythonRuntimeErrorCode;
  message: string;
  retryable: boolean;
  logPath: string;
}

export interface ReadyMarker {
  pythonVersion: string;
  lockSha256: string;
  indexUrl: string;
  pythonMirror: string | null;
  installedAt: string;
}

export interface PythonEnvState {
  phase: PythonEnvPhase;
  root: string;
  pythonPath: string | null;
  error?: PythonRuntimeError;
  percent?: number;
}

export interface ProbeResult {
  url: string;
  ok: boolean;
  ttfbMs: number;
}

export interface PythonEnvLookupOptions {
  dataDir?: string;
  resourceDir?: string;
  platform?: NodeJS.Platform;
}

export interface EnsurePythonEnvOptions extends PythonEnvLookupOptions {
  runUv?: (args: string[], env: NodeJS.ProcessEnv) => Promise<{ code: number; stderr: string }>;
  probe?: (url: string, timeoutMs: number) => Promise<ProbeResult>;
  now?: () => Date;
}

export type EnsurePythonEnvResult =
  | { ok: true; pythonPath: string; reused: boolean; root: string }
  | { ok: false; error: PythonRuntimeError; root: string };
