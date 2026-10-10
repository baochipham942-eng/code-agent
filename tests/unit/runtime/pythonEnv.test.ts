import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeAssetPreparationStatus, RuntimeAssetsStatus } from '../../../src/shared/contract/update';
import { PYTHON_RUNTIME_VERSION } from '../../../src/host/runtime/pythonEnv/constants';
import { ensurePythonEnv } from '../../../src/host/runtime/pythonEnv/ensure';
import { getManagedPythonPath, getPythonEnvState } from '../../../src/host/runtime/pythonEnv/state';
import { withPythonEnvStatus } from '../../../src/host/runtime/pythonEnv/status';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const resourceDir = path.join(repoRoot, 'resources', 'python-runtime');
const temps: string[] = [];
const SUPPORTED: NodeJS.Platform = 'darwin';

const PYPI_INDEX_URL = 'https://pypi.org/simple';
const TUNA_INDEX_URL = 'https://pypi.tuna.tsinghua.edu.cn/simple';
const PYTHON_INSTALL_MIRROR = 'https://registry.npmmirror.com/-/binary/python-build-standalone/';
const PYTHON_DOWNLOAD_PROBE_URL = 'https://releases.astral.sh/github/python-build-standalone/releases/download/20260510/cpython-3.14.5%2B20260510-aarch64-apple-darwin-install_only_stripped.tar.gz';
const OFFLINE_MESSAGE = 'Python runtime install needs a package index, but both PyPI and the mirror are unreachable. Check the network and try again.';
const INSTALL_FAILED_MESSAGE = 'Python runtime install failed. See the install log and try again.';
const UNSUPPORTED_MESSAGE = 'The managed Python runtime is not supported on Windows.';

const ENV_KEYS = [
  'PATH',
  'PYTHONHOME',
  'PYTHONPATH',
  'VIRTUAL_ENV',
  'CONDA_PREFIX',
  'UV_PYTHON_INSTALL_MIRROR',
  'UV_PYTHON_PREFERENCE',
  'UV_NO_CONFIG',
  'UV_CACHE_DIR',
  'UV_PYTHON_INSTALL_DIR',
  'UV_PYTHON_INSTALL_BIN',
] as const;
const envSnapshot = new Map<string, string | undefined>();

interface UvCall {
  args: string[];
  env: NodeJS.ProcessEnv;
}

interface ProbeHit {
  url: string;
  timeoutMs: number;
}

function rememberTemps(dir: string): string {
  temps.push(dir);
  return dir;
}

function makeDataDir(): string {
  return rememberTemps(fs.mkdtempSync(path.join(os.tmpdir(), 'py-env-')));
}

function pythonRoot(dataDir: string): string {
  return path.join(dataDir, 'runtimes', 'python');
}

function writeManagedPython(venvPath: string): void {
  const pythonPath = path.join(venvPath, 'bin', 'python');
  fs.mkdirSync(path.dirname(pythonPath), { recursive: true });
  fs.writeFileSync(pythonPath, '#!/bin/sh\n');
  fs.chmodSync(pythonPath, 0o755);
}

function hashRequirements(): string {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(resourceDir, 'requirements.lock.txt'))).digest('hex');
}

function requirementBlocks(text: string): string[] {
  const blocks: string[][] = [];
  let current: string[] | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^[A-Za-z0-9]/.test(line)) {
      if (current) blocks.push(current);
      current = [line];
      continue;
    }
    if (current) current.push(line);
  }
  if (current) blocks.push(current);
  return blocks.map((block) => block.join('\n'));
}

function emptyStatus(preparation: RuntimeAssetPreparationStatus | null = null): RuntimeAssetsStatus {
  return {
    runtimeBaseDir: '/runtime',
    activeManifestPath: '/runtime/active.json',
    assets: [],
    summary: { installed: 0, bundledFallback: 0, missing: 0, unsupported: 0 },
    preparation,
  };
}

function fastProbe(hits: ProbeHit[]) {
  return async (url: string, timeoutMs: number) => {
    hits.push({ url, timeoutMs });
    return { url, ok: true, ttfbMs: 10 };
  };
}

function successfulRunUv(calls: UvCall[]) {
  return async (args: string[], env: NodeJS.ProcessEnv) => {
    calls.push({ args, env });
    if (args[0] === 'venv') writeManagedPython(args[1]);
    return { code: 0, stderr: '' };
  };
}

function lookup(dataDir: string) {
  return { dataDir, resourceDir, platform: SUPPORTED };
}

beforeEach(() => {
  envSnapshot.clear();
  for (const key of ENV_KEYS) envSnapshot.set(key, process.env[key]);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = envSnapshot.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('python runtime lockfiles', () => {
  it('pins the five packages, the runtime version, and a hash on every requirement block', () => {
    const pyproject = fs.readFileSync(path.join(resourceDir, 'pyproject.toml'), 'utf8');
    const dependencyBlock = pyproject.match(/dependencies\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? '';
    const deps = [...dependencyBlock.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    expect(deps).toEqual(['pandas', 'openpyxl', 'python-pptx', 'python-docx', 'pdfplumber']);
    expect(pyproject).toContain('requires-python = "==3.14.*"');
    expect(pyproject).toContain('package = false');

    expect(fs.readFileSync(path.join(resourceDir, '.python-version'), 'utf8').trim()).toBe(PYTHON_RUNTIME_VERSION);
    expect(fs.readFileSync(path.join(resourceDir, 'uv.lock'), 'utf8')).toContain('requires-python = "==3.14.*"');

    const requirements = fs.readFileSync(path.join(resourceDir, 'requirements.lock.txt'), 'utf8');
    expect(requirements.startsWith(
      '# This file was autogenerated by uv via the following command:\n'
      + '#    uv export --frozen --no-dev --no-emit-project --format requirements-txt -o requirements.lock.txt\n',
    )).toBe(true);
    // uv export writes `--hash=sha256:` on continuation lines, not on the package specifier.
    const blocks = requirementBlocks(requirements);
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) expect(block).toContain('--hash=sha256:');
    for (const name of deps) expect(blocks.some((block) => block.startsWith(`${name}==`))).toBe(true);
  });
});

describe('ensurePythonEnv', () => {
  it('uses PyPI when the probe is fast, isolates the child env, and reuses the install', async () => {
    const dataDir = makeDataDir();
    const root = pythonRoot(dataDir);
    const calls: UvCall[] = [];
    const hits: ProbeHit[] = [];
    const savedPath = process.env.PATH;
    process.env.PYTHONHOME = 'from-parent';
    process.env.PYTHONPATH = 'from-parent';
    process.env.VIRTUAL_ENV = 'from-parent';
    process.env.CONDA_PREFIX = 'from-parent';
    process.env.UV_PYTHON_INSTALL_MIRROR = 'https://parent.example/mirror';
    delete process.env.UV_PYTHON_PREFERENCE;

    let requirementsCopiedBeforePython = false;
    let readyDuringSync = true;
    const runUv = async (args: string[], env: NodeJS.ProcessEnv) => {
      calls.push({ args, env });
      if (args[0] === 'python') {
        requirementsCopiedBeforePython = fs.existsSync(path.join(root, 'project', 'requirements.lock.txt'));
      }
      if (args[0] === 'pip') readyDuringSync = fs.existsSync(path.join(root, 'ready.json'));
      if (args[0] === 'venv') writeManagedPython(args[1]);
      return { code: 0, stderr: '' };
    };

    const first = await ensurePythonEnv({
      ...lookup(dataDir),
      runUv,
      probe: fastProbe(hits),
      now: () => new Date('2026-09-30T00:00:00.000Z'),
    });

    expect(first).toEqual({
      ok: true,
      pythonPath: path.join(root, 'venv', 'bin', 'python'),
      reused: false,
      root,
    });
    expect(requirementsCopiedBeforePython).toBe(true);
    expect(readyDuringSync).toBe(false);
    expect(hits.map((hit) => hit.url)).toEqual([PYPI_INDEX_URL, PYTHON_DOWNLOAD_PROBE_URL]);
    expect(hits.every((hit) => hit.timeoutMs === 3000)).toBe(true);
    expect(calls.map((call) => call.args)).toEqual([
      ['python', 'install', PYTHON_RUNTIME_VERSION],
      ['venv', path.join(root, 'venv'), '--python', PYTHON_RUNTIME_VERSION],
      [
        'pip', 'sync', path.join(root, 'project', 'requirements.lock.txt'),
        '--python', path.join(root, 'venv', 'bin', 'python'),
        '--require-hashes', '--only-binary', ':all:',
        '--index-url', PYPI_INDEX_URL,
        '--compile-bytecode',
      ],
    ]);
    for (const call of calls) {
      expect(call.env).not.toBe(process.env);
      expect(call.env.UV_PYTHON_PREFERENCE).toBe('only-managed');
      expect(call.env.UV_NO_CONFIG).toBe('1');
      expect(call.env.UV_CACHE_DIR).toBe(path.join(root, 'cache'));
      expect(call.env.UV_PYTHON_INSTALL_DIR).toBe(path.join(root, 'interpreters'));
      expect(call.env.UV_PYTHON_INSTALL_BIN).toBe('0');
      expect(call.env.PYTHONHOME).toBeUndefined();
      expect(call.env.PYTHONPATH).toBeUndefined();
      expect(call.env.VIRTUAL_ENV).toBeUndefined();
      expect(call.env.CONDA_PREFIX).toBeUndefined();
      expect(call.env.UV_PYTHON_INSTALL_MIRROR).toBeUndefined();
    }
    expect(process.env.PATH).toBe(savedPath);
    expect(process.env.UV_PYTHON_PREFERENCE).toBeUndefined();
    expect(process.env.PYTHONHOME).toBe('from-parent');
    expect(process.env.UV_PYTHON_INSTALL_MIRROR).toBe('https://parent.example/mirror');

    const log = fs.readFileSync(path.join(root, 'install.log'), 'utf8');
    expect(log).toContain('2026-09-30T00:00:00.000Z');
    expect(log).toContain(PYPI_INDEX_URL);
    expect(log).not.toContain(TUNA_INDEX_URL);
    expect(log).not.toContain('UV_PYTHON_PREFERENCE');

    const ready = JSON.parse(fs.readFileSync(path.join(root, 'ready.json'), 'utf8')) as {
      pythonVersion: string;
      lockSha256: string;
      indexUrl: string;
      pythonMirror: string | null;
    };
    expect(ready.pythonVersion).toBe(PYTHON_RUNTIME_VERSION);
    expect(ready.lockSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ready.lockSha256).toBe(hashRequirements());
    expect(ready.indexUrl).toBe(PYPI_INDEX_URL);
    expect(ready.pythonMirror).toBeNull();
    expect(fs.readFileSync(path.join(root, 'project', '.python-version'), 'utf8').trim()).toBe(PYTHON_RUNTIME_VERSION);

    const installed = withPythonEnvStatus(emptyStatus(), lookup(dataDir));
    expect(installed.assets.at(-1)).toMatchObject({
      id: 'python-env',
      label: 'Python data runtime',
      delivery: 'optional',
      state: 'installed',
      nodeModules: [],
    });
    expect(installed.assets.at(-1)?.files?.[0]?.path).toBe(path.join(root, 'venv', 'bin', 'python'));
    expect(installed.summary).toEqual({ installed: 1, bundledFallback: 0, missing: 0, unsupported: 0 });
    expect(getManagedPythonPath(lookup(dataDir))).toBe(path.join(root, 'venv', 'bin', 'python'));
    expect(path.isAbsolute(getManagedPythonPath(lookup(dataDir)) ?? '')).toBe(true);

    const callsBeforeReuse = calls.length;
    const hitsBeforeReuse = hits.length;
    const second = await ensurePythonEnv({
      ...lookup(dataDir),
      runUv,
      probe: fastProbe(hits),
      now: () => new Date('2026-09-30T00:00:00.000Z'),
    });
    expect(second).toMatchObject({ ok: true, reused: true, pythonPath: path.join(root, 'venv', 'bin', 'python') });
    expect(calls).toHaveLength(callsBeforeReuse);
    expect(hits).toHaveLength(hitsBeforeReuse);
    expect(getPythonEnvState(lookup(dataDir)).phase).toBe('installed');
  });

  it('treats a 1500ms TTFB as fast and 1501ms as slow', async () => {
    const fastDir = makeDataDir();
    const fastHits: ProbeHit[] = [];
    await ensurePythonEnv({
      ...lookup(fastDir),
      runUv: successfulRunUv([]),
      probe: async (url, timeoutMs) => {
        fastHits.push({ url, timeoutMs });
        return { url, ok: true, ttfbMs: url === PYPI_INDEX_URL ? 1500 : 10 };
      },
      now: () => new Date('2026-09-30T00:00:00.000Z'),
    });
    expect(fastHits.map((hit) => hit.url)).not.toContain(TUNA_INDEX_URL);

    const slowDir = makeDataDir();
    const slowCalls: UvCall[] = [];
    const slowHits: ProbeHit[] = [];
    await ensurePythonEnv({
      ...lookup(slowDir),
      runUv: successfulRunUv(slowCalls),
      probe: async (url, timeoutMs) => {
        slowHits.push({ url, timeoutMs });
        return { url, ok: true, ttfbMs: url === PYPI_INDEX_URL ? 1501 : 10 };
      },
      now: () => new Date('2026-09-30T00:00:00.000Z'),
    });
    expect(slowHits.map((hit) => hit.url)).toContain(TUNA_INDEX_URL);
    const sync = slowCalls.find((call) => call.args[0] === 'pip');
    expect(sync?.args).toContain(TUNA_INDEX_URL);
    expect(sync?.env.UV_PYTHON_INSTALL_MIRROR).toBeUndefined();
  });

  it.each([
    { name: 'PyPI probe fails', pypi: { ok: false, ttfbMs: 10 } },
    { name: 'PyPI TTFB is 2000ms', pypi: { ok: true, ttfbMs: 2000 } },
  ])('uses the tuna index and the python mirror when $name', async ({ pypi }) => {
    const dataDir = makeDataDir();
    const root = pythonRoot(dataDir);
    const calls: UvCall[] = [];
    const hits: ProbeHit[] = [];
    await ensurePythonEnv({
      ...lookup(dataDir),
      runUv: successfulRunUv(calls),
      probe: async (url, timeoutMs) => {
        hits.push({ url, timeoutMs });
        if (url === PYPI_INDEX_URL) return { url, ...pypi };
        if (url === TUNA_INDEX_URL) return { url, ok: true, ttfbMs: 2000 };
        return { url, ok: false, ttfbMs: 3000 };
      },
      now: () => new Date('2026-09-30T00:00:00.000Z'),
    });
    expect(hits.map((hit) => hit.url)).toEqual([
      PYPI_INDEX_URL,
      TUNA_INDEX_URL,
      PYTHON_DOWNLOAD_PROBE_URL,
      PYTHON_INSTALL_MIRROR,
    ]);
    expect(calls[0]?.env.UV_PYTHON_INSTALL_MIRROR).toBe(PYTHON_INSTALL_MIRROR);
    expect(calls.find((call) => call.args[0] === 'pip')?.args).toContain(TUNA_INDEX_URL);
    const log = fs.readFileSync(path.join(root, 'install.log'), 'utf8');
    expect(log).toContain(TUNA_INDEX_URL);
    expect(log).toContain(PYTHON_INSTALL_MIRROR);
    const ready = JSON.parse(fs.readFileSync(path.join(root, 'ready.json'), 'utf8')) as { indexUrl: string; pythonMirror: string | null };
    expect(ready.indexUrl).toBe(TUNA_INDEX_URL);
    expect(ready.pythonMirror).toBe(PYTHON_INSTALL_MIRROR);
  });

  it('keeps a slow but reachable PyPI when the tuna probe fails', async () => {
    const dataDir = makeDataDir();
    const root = pythonRoot(dataDir);
    const calls: UvCall[] = [];
    const hits: ProbeHit[] = [];
    const result = await ensurePythonEnv({
      ...lookup(dataDir),
      runUv: successfulRunUv(calls),
      probe: async (url, timeoutMs) => {
        hits.push({ url, timeoutMs });
        if (url === PYPI_INDEX_URL) return { url, ok: true, ttfbMs: 2000 };
        if (url === TUNA_INDEX_URL) return { url, ok: false, ttfbMs: 3000 };
        if (url === PYTHON_DOWNLOAD_PROBE_URL) return { url, ok: true, ttfbMs: 10 };
        return { url, ok: false, ttfbMs: 3000 };
      },
      now: () => new Date('2026-09-30T00:00:00.000Z'),
    });
    expect(result).toMatchObject({ ok: true, reused: false, root });
    expect(hits.map((hit) => hit.url)).toEqual([
      PYPI_INDEX_URL,
      TUNA_INDEX_URL,
      PYTHON_DOWNLOAD_PROBE_URL,
    ]);
    const sync = calls.find((call) => call.args[0] === 'pip');
    expect(sync?.args).toContain(PYPI_INDEX_URL);
    expect(calls[0]?.env.UV_PYTHON_INSTALL_MIRROR).toBeUndefined();
    const log = fs.readFileSync(path.join(root, 'install.log'), 'utf8');
    expect(log).toContain(`chosen index=${PYPI_INDEX_URL} pythonMirror=none`);
    const ready = JSON.parse(fs.readFileSync(path.join(root, 'ready.json'), 'utf8')) as { indexUrl: string };
    expect(ready.indexUrl).toBe(PYPI_INDEX_URL);
  });

  it('keeps a slow but reachable Python download source when the mirror probe fails', async () => {
    const dataDir = makeDataDir();
    const root = pythonRoot(dataDir);
    const calls: UvCall[] = [];
    const hits: ProbeHit[] = [];
    const result = await ensurePythonEnv({
      ...lookup(dataDir),
      runUv: successfulRunUv(calls),
      probe: async (url, timeoutMs) => {
        hits.push({ url, timeoutMs });
        if (url === PYPI_INDEX_URL) return { url, ok: true, ttfbMs: 10 };
        if (url === PYTHON_DOWNLOAD_PROBE_URL) return { url, ok: true, ttfbMs: 2000 };
        return { url, ok: false, ttfbMs: 3000 };
      },
      now: () => new Date('2026-09-30T00:00:00.000Z'),
    });
    expect(result).toMatchObject({ ok: true, reused: false, root });
    expect(hits.map((hit) => hit.url)).toEqual([
      PYPI_INDEX_URL,
      PYTHON_DOWNLOAD_PROBE_URL,
      PYTHON_INSTALL_MIRROR,
    ]);
    expect(calls[0]?.env.UV_PYTHON_INSTALL_MIRROR).toBeUndefined();
    const log = fs.readFileSync(path.join(root, 'install.log'), 'utf8');
    expect(log).toContain(`chosen index=${PYPI_INDEX_URL} pythonMirror=none`);
    const ready = JSON.parse(fs.readFileSync(path.join(root, 'ready.json'), 'utf8')) as { pythonMirror: string | null };
    expect(ready.pythonMirror).toBeNull();
  });

  it('switches a slow Python download source when the mirror probe succeeds', async () => {
    const dataDir = makeDataDir();
    const calls: UvCall[] = [];
    await ensurePythonEnv({
      ...lookup(dataDir),
      runUv: successfulRunUv(calls),
      probe: async (url) => {
        if (url === PYTHON_DOWNLOAD_PROBE_URL) return { url, ok: true, ttfbMs: 2000 };
        return { url, ok: true, ttfbMs: 10 };
      },
      now: () => new Date('2026-09-30T00:00:00.000Z'),
    });
    expect(calls[0]?.env.UV_PYTHON_INSTALL_MIRROR).toBe(PYTHON_INSTALL_MIRROR);
  });

  it('returns OFFLINE before uv when every index probe fails', async () => {
    const dataDir = makeDataDir();
    const root = pythonRoot(dataDir);
    const calls: UvCall[] = [];
    const hits: ProbeHit[] = [];
    const result = await ensurePythonEnv({
      ...lookup(dataDir),
      runUv: successfulRunUv(calls),
      probe: async (url, timeoutMs) => {
        hits.push({ url, timeoutMs });
        return { url, ok: false, ttfbMs: 3000 };
      },
      now: () => new Date('2026-09-30T00:00:00.000Z'),
    });
    expect(result).toEqual({
      ok: false,
      root,
      error: {
        code: 'PYTHON_RUNTIME_OFFLINE',
        message: OFFLINE_MESSAGE,
        retryable: true,
        logPath: path.join(root, 'install.log'),
      },
    });
    expect(hits.map((hit) => hit.url)).toEqual([PYPI_INDEX_URL, TUNA_INDEX_URL]);
    expect(calls).toHaveLength(0);
    const log = fs.readFileSync(path.join(root, 'install.log'), 'utf8');
    expect(log).not.toContain('uv argv');
    expect(fs.existsSync(path.join(root, 'ready.json'))).toBe(false);
    expect(getPythonEnvState(lookup(dataDir)).phase).toBe('failed');
    const overlaid = withPythonEnvStatus(emptyStatus({ assetId: 'uv', phase: 'completed' }), lookup(dataDir));
    expect(overlaid.assets.at(-1)?.state).toBe('missing');
    expect(overlaid.preparation).toEqual({ assetId: 'python-env', phase: 'failed', error: OFFLINE_MESSAGE });
    expect(overlaid.summary).toEqual({ installed: 0, bundledFallback: 0, missing: 1, unsupported: 0 });
  });

  it('returns INSTALL_FAILED without ready.json and retries on the next call', async () => {
    const dataDir = makeDataDir();
    const root = pythonRoot(dataDir);
    const calls: string[][] = [];
    const stderr = Array.from({ length: 50 }, (_, index) => `line-${index}`).join('\n');
    const runUv = async (args: string[]) => {
      calls.push(args);
      return { code: 1, stderr };
    };
    const first = await ensurePythonEnv({
      ...lookup(dataDir),
      runUv,
      probe: fastProbe([]),
      now: () => new Date('2026-09-30T00:00:00.000Z'),
    });
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.error.code).toBe('PYTHON_RUNTIME_INSTALL_FAILED');
    expect(first.error.retryable).toBe(true);
    expect(first.error.message).toBe(INSTALL_FAILED_MESSAGE);
    expect(first.error.message).not.toMatch(/[\u3400-\u9FFF]/);
    expect(fs.existsSync(path.join(root, 'ready.json'))).toBe(false);
    const log = fs.readFileSync(path.join(root, 'install.log'), 'utf8');
    expect(log).toContain('line-10');
    expect(log).toContain('line-49');
    expect(log).not.toContain('line-9');
    expect(log.indexOf('uv argv')).toBeLessThan(log.indexOf('uv exit'));

    const before = calls.length;
    const second = await ensurePythonEnv({
      ...lookup(dataDir),
      runUv,
      probe: fastProbe([]),
      now: () => new Date('2026-09-30T00:00:00.000Z'),
    });
    expect(second.ok).toBe(false);
    expect(calls.length).toBeGreaterThan(before);
    expect(calls[before]?.[0]).toBe('python');
  });

  it('runs one install for two concurrent callers and reports installing at the python step', async () => {
    const dataDir = makeDataDir();
    const root = pythonRoot(dataDir);
    let uvCalls = 0;
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let observed: { phase?: string; percent?: number; preparation?: RuntimeAssetPreparationStatus | null } = {};
    const runUv = async (args: string[]) => {
      uvCalls += 1;
      if (args[0] === 'python') {
        const state = getPythonEnvState(lookup(dataDir));
        const overlaid = withPythonEnvStatus(emptyStatus(null), lookup(dataDir));
        observed = { phase: state.phase, percent: state.percent, preparation: overlaid.preparation };
        await gate;
      }
      if (args[0] === 'venv') writeManagedPython(args[1]);
      return { code: 0, stderr: '' };
    };
    const probe = fastProbe([]);
    const first = ensurePythonEnv({ ...lookup(dataDir), runUv, probe, now: () => new Date('2026-09-30T00:00:00.000Z') });
    const second = ensurePythonEnv({ ...lookup(dataDir), runUv, probe, now: () => new Date('2026-09-30T00:00:00.000Z') });
    await vi.waitFor(() => expect(uvCalls).toBe(1), { timeout: 5000 });
    release();
    const [left, right] = await Promise.all([first, second]);
    expect(uvCalls).toBe(3);
    expect(left).toEqual(right);
    expect(left).toMatchObject({ ok: true, reused: false, root });
    expect(observed).toEqual({
      phase: 'installing',
      percent: 50,
      preparation: { assetId: 'python-env', phase: 'installing', percent: 50 },
    });
    expect(getPythonEnvState(lookup(dataDir)).phase).toBe('installed');
  });

  it('treats a mismatched lock hash as missing and reinstalls after wiping the venv', async () => {
    const dataDir = makeDataDir();
    const root = pythonRoot(dataDir);
    fs.mkdirSync(path.join(root, 'venv', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'venv', 'bin', 'python'), 'old');
    fs.writeFileSync(path.join(root, 'ready.json'), JSON.stringify({
      pythonVersion: PYTHON_RUNTIME_VERSION,
      lockSha256: 'a'.repeat(64),
      indexUrl: PYPI_INDEX_URL,
      pythonMirror: null,
      installedAt: '2020-01-01T00:00:00.000Z',
    }));
    expect(getPythonEnvState(lookup(dataDir)).phase).toBe('missing');
    expect(getManagedPythonPath(lookup(dataDir))).toBeNull();

    let venvExistedAtFirstUv = true;
    const calls: UvCall[] = [];
    await ensurePythonEnv({
      ...lookup(dataDir),
      runUv: async (args, env) => {
        calls.push({ args, env });
        if (args[0] === 'python') venvExistedAtFirstUv = fs.existsSync(path.join(root, 'venv'));
        if (args[0] === 'venv') writeManagedPython(args[1]);
        return { code: 0, stderr: '' };
      },
      probe: fastProbe([]),
      now: () => new Date('2026-09-30T00:00:00.000Z'),
    });
    expect(venvExistedAtFirstUv).toBe(false);
    expect(calls[0]?.args[0]).toBe('python');
    const ready = JSON.parse(fs.readFileSync(path.join(root, 'ready.json'), 'utf8')) as { lockSha256: string };
    expect(ready.lockSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ready.lockSha256).toBe(hashRequirements());
  });

  it('returns null for the interpreter when the env is missing even if python3 is first on PATH', () => {
    const dataDir = makeDataDir();
    const bin = rememberTemps(fs.mkdtempSync(path.join(os.tmpdir(), 'py-fake-bin-')));
    fs.writeFileSync(path.join(bin, 'python3'), '#!/bin/sh\n');
    fs.chmodSync(path.join(bin, 'python3'), 0o755);
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ''}`;
    expect(getManagedPythonPath(lookup(dataDir))).toBeNull();
    expect(getPythonEnvState(lookup(dataDir)).phase).toBe('missing');
  });

  it('rejects Windows without calling uv or the network', async () => {
    const dataDir = makeDataDir();
    const calls: UvCall[] = [];
    let probed = false;
    const result = await ensurePythonEnv({
      dataDir,
      resourceDir,
      platform: 'win32',
      runUv: async (args, env) => {
        calls.push({ args, env });
        return { code: 0, stderr: '' };
      },
      probe: async (url) => {
        probed = true;
        return { url, ok: true, ttfbMs: 1 };
      },
      now: () => new Date('2026-09-30T00:00:00.000Z'),
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'PYTHON_RUNTIME_UNSUPPORTED',
        message: UNSUPPORTED_MESSAGE,
        retryable: false,
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('Windows');
    expect(result.error.message).not.toMatch(/[\u3400-\u9FFF]/);
    expect(calls).toHaveLength(0);
    expect(probed).toBe(false);
    expect(getManagedPythonPath({ dataDir, resourceDir, platform: 'win32' })).toBeNull();
    expect(getPythonEnvState({ dataDir, resourceDir, platform: 'win32' }).phase).toBe('unsupported');
    const overlaid = withPythonEnvStatus(emptyStatus(), { dataDir, resourceDir, platform: 'win32' });
    expect(overlaid.assets.at(-1)?.state).toBe('unsupported');
    expect(overlaid.summary.unsupported).toBe(1);
  });

  it('keeps the caller preparation while python is idle', () => {
    const dataDir = makeDataDir();
    const preparation: RuntimeAssetPreparationStatus = { assetId: 'uv', phase: 'completed', percent: 100 };
    const overlaid = withPythonEnvStatus(emptyStatus(preparation), lookup(dataDir));
    expect(overlaid.preparation).toEqual(preparation);
    expect(overlaid.assets.at(-1)).toMatchObject({
      id: 'python-env',
      label: 'Python data runtime',
      delivery: 'optional',
      state: 'missing',
      nodeModules: [],
    });
    expect(overlaid.summary).toEqual({ installed: 0, bundledFallback: 0, missing: 1, unsupported: 0 });
  });
});
