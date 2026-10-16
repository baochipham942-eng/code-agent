// ============================================================================
// Managed Python env（NEO_PYTHON）注入测试 — N-PY-RUNTIME-K2
//
// 真状态机（state.ts/layout.ts/errors.ts 均为真实现），用 CODE_AGENT_DATA_DIR
// 重定向到临时目录构造 installed/missing/failed 三态；只有 ensurePythonEnv 打桩
// （真装要走网络拉 uv + PyPI，单测禁止）。K1 契约：ensurePythonEnv 同步登记
// inflight（getPythonEnvState 随即翻 installing），用 setInflight 复刻该行为。
// ============================================================================

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../../src/host/runtime/pythonEnv/ensure', () => ({
  ensurePythonEnv: vi.fn(),
}));

import { ensurePythonEnv } from '../../../../../src/host/runtime/pythonEnv/ensure';
import { offlineError } from '../../../../../src/host/runtime/pythonEnv/errors';
import { resolvePythonRoot } from '../../../../../src/host/runtime/pythonEnv/layout';
import {
  clearInflight,
  clearInstallPercent,
  forgetError,
  getManagedPythonPath,
  rememberError,
  setInflight,
  setInstallPercent,
} from '../../../../../src/host/runtime/pythonEnv/state';
import { applyManagedPython } from '../../../../../src/host/tools/modules/shell/managedPythonEnv';
import { createEvalSafeShellEnv } from '../../../../../src/host/tools/modules/shell/evalSafeShellEnv';

const ensurePythonEnvMock = vi.mocked(ensurePythonEnv);

const repoResourcesPython = path.resolve(__dirname, '../../../../../resources/python-runtime');

function makeTempDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'neo-py-env-'));
}

/** 在 <dataDir>/runtimes/python 下摆出 K1 的 installed 现场（venv python + 匹配 lock 的 ready.json）。 */
function installManagedPython(root: string): string {
  const pythonPath = path.join(root, 'venv', 'bin', 'python');
  fs.mkdirSync(path.dirname(pythonPath), { recursive: true });
  fs.writeFileSync(pythonPath, '#!/bin/sh\n', { mode: 0o755 });
  const lockSha256 = crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(repoResourcesPython, 'requirements.lock.txt')))
    .digest('hex');
  fs.writeFileSync(
    path.join(root, 'ready.json'),
    `${JSON.stringify({
      pythonVersion: '3.14.5',
      lockSha256,
      indexUrl: 'https://pypi.org/simple',
      pythonMirror: null,
      installedAt: '2026-10-03T00:00:00.000Z',
    })}\n`,
  );
  return pythonPath;
}

function resetPythonState(root: string): void {
  clearInflight(root);
  clearInstallPercent(root);
  forgetError(root);
}

describe('applyManagedPython (unit)', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = makeTempDataDir();
    vi.stubEnv('CODE_AGENT_DATA_DIR', dataDir);
    ensurePythonEnvMock.mockReset();
    ensurePythonEnvMock.mockResolvedValue({ ok: true, pythonPath: '/fake/venv/bin/python', reused: false, root: resolvePythonRoot() });
  });

  afterEach(() => {
    resetPythonState(resolvePythonRoot());
    vi.unstubAllEnvs();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('installed ⇒ sets NEO_PYTHON to the managed interpreter path and returns null', () => {
    const pythonPath = installManagedPython(resolvePythonRoot());
    expect(getManagedPythonPath()).toBe(pythonPath);
    const env: Record<string, string> = { PATH: '/usr/bin:/bin' };
    expect(applyManagedPython(env, 'echo hi')).toBeNull();
    expect(env.NEO_PYTHON).toBe(pythonPath);
    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(ensurePythonEnvMock).not.toHaveBeenCalled();
  });

  it('missing and command without NEO_PYTHON ⇒ env untouched, no install kicked', () => {
    const env: Record<string, string> = { PATH: '/usr/bin:/bin' };
    expect(applyManagedPython(env, 'echo "$HOME"')).toBeNull();
    expect(env).toEqual({ PATH: '/usr/bin:/bin' });
    expect(ensurePythonEnvMock).not.toHaveBeenCalled();
  });

  it('missing and command references NEO_PYTHON ⇒ blocks with INSTALLING and kicks one install', () => {
    const env: Record<string, string> = {};
    const block = applyManagedPython(env, '"$NEO_PYTHON" /tmp/a.py');
    expect(block?.ok).toBe(false);
    expect(block?.code).toBe('PYTHON_RUNTIME_INSTALLING');
    expect(block?.error).toContain('Re-run');
    expect(env).toEqual({});
    expect(ensurePythonEnvMock).toHaveBeenCalledTimes(1);
  });

  it('K1 failure (OFFLINE) ⇒ carries the failure code, plain reason and retry hint; never a system python', () => {
    const root = resolvePythonRoot();
    rememberError(root, offlineError(root));
    const env: Record<string, string> = {};
    const block = applyManagedPython(env, 'python3 -c 1 && "$NEO_PYTHON" x.py');
    expect(block?.code).toBe('PYTHON_RUNTIME_OFFLINE');
    expect(block?.error).toContain('unreachable');
    expect(block?.error).toContain('Retry');
    expect(env.NEO_PYTHON).toBeUndefined();
  });
});

describe('createEvalSafeShellEnv × managed python', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = makeTempDataDir();
    vi.stubEnv('CODE_AGENT_DATA_DIR', dataDir);
    ensurePythonEnvMock.mockReset();
    ensurePythonEnvMock.mockResolvedValue({ ok: true, pythonPath: '/fake/venv/bin/python', reused: false, root: resolvePythonRoot() });
  });

  afterEach(() => {
    resetPythonState(resolvePythonRoot());
    vi.unstubAllEnvs();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('installed ⇒ NEO_PYTHON injected and every other key byte-identical to the missing-dir result', () => {
    const pythonPath = installManagedPython(resolvePythonRoot());
    const withManaged = createEvalSafeShellEnv({ PATH: process.env.PATH }, '/tmp/proj', undefined, {
      allowNetwork: false,
      command: 'echo hi',
    });
    const otherDir = makeTempDataDir();
    vi.stubEnv('CODE_AGENT_DATA_DIR', otherDir);
    const withoutManaged = createEvalSafeShellEnv({ PATH: process.env.PATH }, '/tmp/proj', undefined, {
      allowNetwork: false,
      command: 'echo hi',
    });
    fs.rmSync(otherDir, { recursive: true, force: true });

    expect(withManaged.ok).toBe(true);
    expect(withoutManaged.ok).toBe(true);
    if (!withManaged.ok || !withoutManaged.ok) return;
    expect(withManaged.env.NEO_PYTHON).toBe(pythonPath);
    const stripLocal = ({ CODE_AGENT_DATA_DIR: _stub, NEO_PYTHON: _py, ...rest }: Record<string, string>) => rest;
    // 逐键逐值一致（含 PATH；CODE_AGENT_DATA_DIR 是本测试自己的 stub 值、NEO_PYTHON
    // 是被测注入项且已单独断言，两者剔除后比较）
    expect(stripLocal(withManaged.env)).toEqual(stripLocal(withoutManaged.env));
    expect(withoutManaged.env.NEO_PYTHON).toBeUndefined();
    expect(ensurePythonEnvMock).not.toHaveBeenCalled();
  });

  it('missing and command without NEO_PYTHON ⇒ result ok, no NEO_PYTHON, no install started', () => {
    const result = createEvalSafeShellEnv(undefined, '/tmp/proj', undefined, {
      allowNetwork: false,
      command: 'rg -n pattern src/',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.env.NEO_PYTHON).toBeUndefined();
    expect(ensurePythonEnvMock).not.toHaveBeenCalled();
  });

  it('missing and command runs "$NEO_PYTHON a.py" ⇒ structured INSTALLING error, install started exactly once', () => {
    const refill = { allowNetwork: false, command: '"$NEO_PYTHON" /tmp/a.py' } as const;
    const first = createEvalSafeShellEnv(undefined, '/tmp/proj', undefined, refill);
    expect(first.ok).toBe(false);
    if (!first.ok) {
      expect(first.code).toBe('PYTHON_RUNTIME_INSTALLING');
      expect(first.error).toMatch(/managed Python/i);
      expect(first.error).toContain('Re-run');
    }
    expect(ensurePythonEnvMock).toHaveBeenCalledTimes(1);

    // K1 契约复刻：ensure 同步登记 inflight → 第二次调用看到 installing，不再 kick
    const root = resolvePythonRoot();
    setInflight(root, new Promise(() => {}));
    setInstallPercent(root, 42);
    const second = createEvalSafeShellEnv(undefined, '/tmp/proj', undefined, refill);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.code).toBe('PYTHON_RUNTIME_INSTALLING');
      expect(second.error).toContain('42%');
    }
    expect(ensurePythonEnvMock).toHaveBeenCalledTimes(1);
  });

  it('K1 OFFLINE failure ⇒ bash result carries the reason and retry hint, even with a fake python3 first on PATH', () => {
    const root = resolvePythonRoot();
    rememberError(root, offlineError(root));
    const fakeBin = makeTempDataDir();
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, 'python3'), '#!/bin/sh\n', { mode: 0o755 });
    const result = createEvalSafeShellEnv(
      { PATH: `${fakeBin}:${process.env.PATH}` },
      '/tmp/proj',
      undefined,
      { allowNetwork: false, command: '"$NEO_PYTHON" /tmp/a.py' },
    );
    fs.rmSync(fakeBin, { recursive: true, force: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('PYTHON_RUNTIME_OFFLINE');
      expect(result.error).toContain('unreachable');
      expect(result.error).toContain('Retry from Settings → Local capabilities');
    }
    // 失败即重试信号：再 kick 一次后台安装，但不 exec、不指向系统 python
    expect(ensurePythonEnvMock).toHaveBeenCalledTimes(1);
  });
});
