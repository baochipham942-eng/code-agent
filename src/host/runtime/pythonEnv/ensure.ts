import fs from 'fs';
import path from 'path';
import {
  PROBE_SLOW_TTFB_MS,
  PROBE_TIMEOUT_MS,
  PYPI_INDEX_URL,
  PYTHON_DOWNLOAD_PROBE_URL,
  PYTHON_INSTALL_MIRROR,
  PYTHON_RUNTIME_VERSION,
  TUNA_INDEX_URL,
} from './constants';
import { installFailedError, offlineError, unsupportedError } from './errors';
import {
  bundledRequirementsPath,
  copyProjectFiles,
  hashFile,
  projectDir,
  readyJsonPath,
  resolvePythonRoot,
  resolveResourceDir,
  venvDir,
  venvPythonPath,
} from './layout';
import { appendInstallLog, appendUvOutcome } from './log';
import { defaultProbe } from './probe';
import {
  clearInflight,
  clearInstallPercent,
  forgetError,
  getInflight,
  getPythonEnvState,
  rememberError,
  setInflight,
  setInstallPercent,
} from './state';
import type { EnsurePythonEnvOptions, EnsurePythonEnvResult, ProbeResult, ReadyMarker } from './types';
import { buildUvEnv, defaultRunUv } from './uvEnv';

const STEP_PROBE = 10;
const STEP_COPY = 25;
const STEP_PYTHON = 50;
const STEP_VENV = 70;
const STEP_SYNC = 90;

function isFast(result: ProbeResult): boolean {
  return result.ok && result.ttfbMs <= PROBE_SLOW_TTFB_MS;
}

async function probeOne(
  probe: NonNullable<EnsurePythonEnvOptions['probe']>,
  url: string,
  root: string,
  now: () => Date,
): Promise<ProbeResult> {
  let ok: boolean;
  let ttfbMs = PROBE_TIMEOUT_MS;
  try {
    const result = await probe(url, PROBE_TIMEOUT_MS);
    ok = result.ok === true;
    if (typeof result.ttfbMs === 'number') ttfbMs = result.ttfbMs;
  } catch {
    ok = false;
  }
  appendInstallLog(root, now(), `probe url=${url} ok=${ok} ttfbMs=${ttfbMs}`);
  return { url, ok, ttfbMs };
}

async function chooseIndex(
  probe: NonNullable<EnsurePythonEnvOptions['probe']>,
  root: string,
  now: () => Date,
): Promise<string | null> {
  const pypi = await probeOne(probe, PYPI_INDEX_URL, root, now);
  if (isFast(pypi)) return PYPI_INDEX_URL;
  const tuna = await probeOne(probe, TUNA_INDEX_URL, root, now);
  if (tuna.ok) return TUNA_INDEX_URL;
  return null;
}

async function chooseMirror(
  probe: NonNullable<EnsurePythonEnvOptions['probe']>,
  root: string,
  now: () => Date,
): Promise<string | null> {
  const primary = await probeOne(probe, PYTHON_DOWNLOAD_PROBE_URL, root, now);
  if (isFast(primary)) return null;
  // The mirror is selected when the primary source is not fast, even if this probe fails.
  await probeOne(probe, PYTHON_INSTALL_MIRROR, root, now);
  return PYTHON_INSTALL_MIRROR;
}

async function runLoggedUv(
  runUv: NonNullable<EnsurePythonEnvOptions['runUv']>,
  root: string,
  now: () => Date,
  args: string[],
  env: NodeJS.ProcessEnv,
  percent: number,
): Promise<{ code: number; stderr: string }> {
  setInstallPercent(root, percent);
  appendInstallLog(root, now(), `uv argv: ${args.join(' ')}`);
  const result = await runUv(args, env);
  appendUvOutcome(root, now(), { code: result.code, stderr: result.stderr ?? '' });
  return { code: result.code, stderr: result.stderr ?? '' };
}

function writeReady(root: string, marker: ReadyMarker): void {
  // ready.json is the installed bit. Write it last, via temp+rename, so a crash
  // mid-install cannot look installed.
  const target = readyJsonPath(root);
  const temporary = path.join(root, `.ready.${process.pid}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(marker)}\n`);
  fs.renameSync(temporary, target);
}

async function runInstall(
  options: EnsurePythonEnvOptions,
  root: string,
  resourceDir: string,
): Promise<EnsurePythonEnvResult> {
  const runUv = options.runUv ?? defaultRunUv;
  const probe = options.probe ?? defaultProbe;
  const now = options.now ?? ((): Date => new Date());
  try {
    fs.mkdirSync(root, { recursive: true });
    fs.rmSync(readyJsonPath(root), { force: true });
    fs.rmSync(venvDir(root), { recursive: true, force: true });
    setInstallPercent(root, STEP_PROBE);

    const indexUrl = await chooseIndex(probe, root, now);
    if (!indexUrl) {
      appendInstallLog(root, now(), 'chosen index=none pythonMirror=none');
      return { ok: false, error: offlineError(root), root };
    }
    const mirror = await chooseMirror(probe, root, now);
    appendInstallLog(root, now(), `chosen index=${indexUrl} pythonMirror=${mirror ?? 'none'}`);

    setInstallPercent(root, STEP_COPY);
    copyProjectFiles(resourceDir, root);
    const lockSha256 = hashFile(bundledRequirementsPath(resourceDir));
    const env = buildUvEnv({ root, parentEnv: process.env, mirror });

    const python = await runLoggedUv(
      runUv,
      root,
      now,
      ['python', 'install', PYTHON_RUNTIME_VERSION],
      env,
      STEP_PYTHON,
    );
    if (python.code !== 0) return { ok: false, error: installFailedError(root), root };

    const venv = await runLoggedUv(
      runUv,
      root,
      now,
      ['venv', venvDir(root), '--python', PYTHON_RUNTIME_VERSION],
      env,
      STEP_VENV,
    );
    if (venv.code !== 0) return { ok: false, error: installFailedError(root), root };

    const requirements = path.join(projectDir(root), 'requirements.lock.txt');
    const pythonPath = venvPythonPath(root);
    const sync = await runLoggedUv(
      runUv,
      root,
      now,
      [
        'pip', 'sync', requirements,
        '--python', pythonPath,
        '--require-hashes',
        '--only-binary', ':all:',
        '--index-url', indexUrl,
        '--compile-bytecode',
      ],
      env,
      STEP_SYNC,
    );
    if (sync.code !== 0) return { ok: false, error: installFailedError(root), root };

    writeReady(root, {
      pythonVersion: PYTHON_RUNTIME_VERSION,
      lockSha256,
      indexUrl,
      pythonMirror: mirror,
      installedAt: now().toISOString(),
    });
    return { ok: true, pythonPath, reused: false, root };
  } catch (error) {
    try {
      const reason = error instanceof Error ? error.message : String(error);
      appendInstallLog(root, now(), `install failed: ${reason}`);
    } catch {
      // The install log itself failed; the caller still gets a structured error.
    }
    return { ok: false, error: installFailedError(root), root };
  }
}

function finish(root: string, result: EnsurePythonEnvResult, resolve: (result: EnsurePythonEnvResult) => void): void {
  if (result.ok) forgetError(root);
  else rememberError(root, result.error);
  clearInflight(root);
  clearInstallPercent(root);
  resolve(result);
}

export function ensurePythonEnv(options: EnsurePythonEnvOptions = {}): Promise<EnsurePythonEnvResult> {
  const platform = options.platform ?? process.platform;
  const root = resolvePythonRoot(options.dataDir);
  if (platform === 'win32') {
    return Promise.resolve({ ok: false, error: unsupportedError(root), root });
  }
  const existing = getInflight(root);
  if (existing) return existing;
  const resourceDir = resolveResourceDir(options.resourceDir);
  const state = getPythonEnvState({ dataDir: options.dataDir, resourceDir, platform });
  if (state.phase === 'installed' && state.pythonPath) {
    return Promise.resolve({ ok: true, pythonPath: state.pythonPath, reused: true, root: state.root });
  }

  let resolveRun: (result: EnsurePythonEnvResult) => void = () => {};
  const promise = new Promise<EnsurePythonEnvResult>((resolve) => {
    resolveRun = resolve;
  });
  setInflight(root, promise);
  void runInstall(options, root, resourceDir).then(
    (result) => finish(root, result, resolveRun),
    () => finish(root, { ok: false, error: installFailedError(root), root }, resolveRun),
  );
  return promise;
}
