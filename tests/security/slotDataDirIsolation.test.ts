// ============================================================================
// 槽数据目录读隔离 — Dev 槽不得读到生产槽文件内容
// ============================================================================
// 真机 2026-09-06：Dev 槽会话 Glob/Read 了 ~/.code-agent/memory 与 config.json。
// 断言咬在「拿不到另一个槽的文件内容」上，不咬内部函数返回值。
// ============================================================================

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/host/tools/shell/dynamicDescription', () => ({
  generateBashDescription: async () => null,
}));

import { getUserConfigDir } from '../../src/host/config/configPaths';
import {
  CROSS_SLOT_READ_ALLOW_ENV,
  CROSS_SLOT_READ_ALLOWLIST_ENV,
  evaluateSlotDataDirAccess,
  FOREIGN_SLOT_DATA_DIR_CODE,
} from '../../src/host/security/slotDataDirGuard';
import { getToolCache } from '../../src/host/services/infra/toolCache';
import { fileReadTracker } from '../../src/host/tools/fileReadTracker';
import { getProtocolRegistry } from '../../src/host/tools/protocolRegistry';
import { ToolExecutor } from '../../src/host/tools/toolExecutor';
import { __setRgBinaryPathForTest } from '../../src/host/tools/modules/shell/grep';
import type { ToolExecutionResult } from '../../src/host/tools/types';
import { resetPermissionModeManager } from '../../src/host/permissions/modes';

const PROD_SENTINEL = 'SLOT_ISOLATION_SENTINEL_PROD_ONLY_9f3a';
const OWN_SENTINEL = 'SLOT_ISOLATION_OWN_OK_7c21';
const PROBE_SENTINEL = 'SLOT_ISOLATION_PROBE_SLOT_4e90';

function leakedText(result: ToolExecutionResult): string {
  return [result.error, result.output, result.result, JSON.stringify(result)]
    .map((value) => (typeof value === 'string' ? value : JSON.stringify(value)))
    .join('\n');
}

describe('槽数据目录读隔离', () => {
  let fakeHome: string;
  let projectDir: string;
  let prodSlot: string;
  let devSlot: string;
  let probeSlot: string;
  let prodFile: string;
  let ownFile: string;
  let probeFile: string;

  beforeAll(() => {
    getProtocolRegistry();
  });

  beforeEach(() => {
    fakeHome = mkdtempSync(path.join(os.tmpdir(), 'slot-isolation-home-'));
    projectDir = mkdtempSync(path.join(os.tmpdir(), 'slot-isolation-project-'));
    prodSlot = path.join(fakeHome, '.code-agent');
    devSlot = path.join(fakeHome, '.code-agent-dev');
    probeSlot = path.join(fakeHome, '.code-agent-chatprobe');
    prodFile = path.join(prodSlot, 'memory', 'notes.md');
    ownFile = path.join(devSlot, 'memory', 'notes.md');
    probeFile = path.join(probeSlot, 'memory', 'notes.md');
    mkdirSync(path.dirname(prodFile), { recursive: true });
    mkdirSync(path.dirname(ownFile), { recursive: true });
    mkdirSync(path.dirname(probeFile), { recursive: true });
    writeFileSync(prodFile, PROD_SENTINEL);
    writeFileSync(ownFile, OWN_SENTINEL);
    writeFileSync(probeFile, PROBE_SENTINEL);
    writeFileSync(path.join(prodSlot, 'config.json'), `{"secret":"${PROD_SENTINEL}"}`);

    vi.stubEnv('HOME', fakeHome);
    vi.stubEnv('CODE_AGENT_HOME', fakeHome);
    vi.stubEnv('CODE_AGENT_DATA_DIR', devSlot);
    delete process.env[CROSS_SLOT_READ_ALLOW_ENV];
    delete process.env[CROSS_SLOT_READ_ALLOWLIST_ENV];

    getToolCache().clear();
    fileReadTracker.clear();
    resetPermissionModeManager();
  });

  afterEach(() => {
    resetPermissionModeManager();
    fileReadTracker.clear();
    vi.unstubAllEnvs();
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  function buildExecutor(): ToolExecutor {
    const executor = new ToolExecutor({
      workingDirectory: projectDir,
      requestPermission: async () => true,
    });
    executor.setAuditEnabled(false);
    return executor;
  }

  function expectForeignDenied(result: ToolExecutionResult, slotName: string, sentinel: string): void {
    expect(leakedText(result), 'dev 槽不得拿到生产槽文件内容').not.toContain(sentinel);
    expect(result.success).toBe(false);
    expect(result.error).toContain(`这是另一个槽（${slotName}）的数据目录，当前槽无权读取`);
    expect(result.metadata?.code).toBe(FOREIGN_SLOT_DATA_DIR_CODE);
  }

  it('当前槽就是 getUserConfigDir 解析出来的 dev 槽', () => {
    expect(path.resolve(getUserConfigDir())).toBe(path.resolve(devSlot));
  });

  it('Read 拒读生产槽文件并给出槽名原因', async () => {
    const result = await buildExecutor().execute(
      'Read',
      { file_path: prodFile },
      { sessionId: 'slot-isolation-read' },
    );
    expectForeignDenied(result, '.code-agent', PROD_SENTINEL);
  });

  it('Glob 拒扫生产槽目录，结果里不能出现生产槽文件内容或路径泄漏内容', async () => {
    const result = await buildExecutor().execute(
      'Glob',
      { pattern: '**/*', path: prodSlot },
      { sessionId: 'slot-isolation-glob' },
    );
    expectForeignDenied(result, '.code-agent', PROD_SENTINEL);
  });

  it('Grep 拒搜生产槽文件', async () => {
    const result = await buildExecutor().execute(
      'Grep',
      { pattern: PROD_SENTINEL, path: prodFile },
      { sessionId: 'slot-isolation-grep' },
    );
    expectForeignDenied(result, '.code-agent', PROD_SENTINEL);
  });

  it('Bash cat 拒读生产槽文件', async () => {
    const result = await buildExecutor().execute(
      'Bash',
      { command: `cat ${JSON.stringify(prodFile)}` },
      { sessionId: 'slot-isolation-bash-cat' },
    );
    expectForeignDenied(result, '.code-agent', PROD_SENTINEL);
  });

  it('真阴：当前槽读自己的数据目录照常成功', async () => {
    const result = await buildExecutor().execute(
      'Read',
      { file_path: ownFile },
      { sessionId: 'slot-isolation-own' },
    );
    expect(result.success).toBe(true);
    expect(leakedText(result)).toContain(OWN_SENTINEL);
    expect(result.error ?? '').not.toContain('另一个槽');
  });

  it('未枚举的自定义槽名同样被拒', async () => {
    const result = await buildExecutor().execute(
      'Read',
      { file_path: probeFile },
      { sessionId: 'slot-isolation-probe' },
    );
    expectForeignDenied(result, '.code-agent-chatprobe', PROBE_SENTINEL);
  });

  it('白名单放行指定槽根后能读通', async () => {
    vi.stubEnv(CROSS_SLOT_READ_ALLOWLIST_ENV, prodSlot);
    const result = await buildExecutor().execute(
      'Read',
      { file_path: prodFile },
      { sessionId: 'slot-isolation-allowlist' },
    );
    expect(result.success).toBe(true);
    expect(leakedText(result)).toContain(PROD_SENTINEL);
  });

  it('显式 env 放行后跨槽读能读通', async () => {
    vi.stubEnv(CROSS_SLOT_READ_ALLOW_ENV, '1');
    const result = await buildExecutor().execute(
      'Read',
      { file_path: prodFile },
      { sessionId: 'slot-isolation-allow-env' },
    );
    expect(result.success).toBe(true);
    expect(leakedText(result)).toContain(PROD_SENTINEL);
  });

  function discoveryLeakText(result: ToolExecutionResult): string {
    const metadata = result.metadata ?? {};
    return [
      result.error,
      result.output,
      JSON.stringify(metadata.matches ?? []),
      JSON.stringify(metadata.artifact && typeof metadata.artifact === 'object'
        ? (metadata.artifact as { preview?: string }).preview
        : ''),
    ].join('\n');
  }

  function expectNoForeignLeak(result: ToolExecutionResult, sentinel: string, foreignPath: string): void {
    const text = discoveryLeakText(result);
    expect(text, '跨槽文件内容不能到达调用方').not.toContain(sentinel);
    expect(text, '跨槽文件路径不能到达调用方').not.toContain(foreignPath);
    expect(text, '相对路径也不能泄漏生产槽').not.toContain('.code-agent/memory');
    expect(text).not.toContain('.code-agent/config.json');
    expect(text).not.toContain(`${path.sep}.code-agent${path.sep}memory`);
  }

  it('Bash 中途 cd 后按新目录检查：cd "$HOME" && cat 生产槽配置被拒', async () => {
    const result = await buildExecutor().execute(
      'Bash',
      { command: 'cd "$HOME" && cat .code-agent/config.json' },
      { sessionId: 'slot-isolation-bash-cd-and' },
    );
    expectForeignDenied(result, '.code-agent', PROD_SENTINEL);
    expectNoForeignLeak(result, PROD_SENTINEL, prodFile);
  });

  it('Bash 连续切目录：cd A; cd B; cat 生产槽配置被拒', async () => {
    const result = await buildExecutor().execute(
      'Bash',
      { command: `cd ${JSON.stringify(projectDir)}; cd "$HOME"; cat .code-agent/config.json` },
      { sessionId: 'slot-isolation-bash-cd-seq' },
    );
    expectForeignDenied(result, '.code-agent', PROD_SENTINEL);
    expectNoForeignLeak(result, PROD_SENTINEL, prodFile);
  });

  it('Bash 子 shell 切目录：(cd HOME; cat 生产槽配置) 被拒', async () => {
    const result = await buildExecutor().execute(
      'Bash',
      { command: '(cd "$HOME"; cat .code-agent/config.json)' },
      { sessionId: 'slot-isolation-bash-cd-subshell' },
    );
    expectForeignDenied(result, '.code-agent', PROD_SENTINEL);
    expectNoForeignLeak(result, PROD_SENTINEL, prodFile);
  });

  it('从 home 递归 Glob 结果不含生产槽内容或路径', async () => {
    for (const pattern of ['**/*', '**/.code-agent/**']) {
      const result = await buildExecutor().execute(
        'Glob',
        { pattern, path: fakeHome },
        { sessionId: `slot-isolation-glob-home-${pattern}` },
      );
      expectNoForeignLeak(result, PROD_SENTINEL, prodFile);
      expect(result.error ?? '').not.toContain('另一个槽');
    }
  });

  it('从 home 递归 Grep 结果不含生产槽内容或路径', async () => {
    const result = await buildExecutor().execute(
      'Grep',
      { pattern: PROD_SENTINEL, path: fakeHome },
      { sessionId: 'slot-isolation-grep-home' },
    );
    expectNoForeignLeak(result, PROD_SENTINEL, prodFile);
    expect(result.error ?? '').not.toContain('另一个槽');
  });

  it('从 home 走系统 grep -r 结果不含生产槽内容或路径', async () => {
    __setRgBinaryPathForTest(null);
    try {
      const result = await buildExecutor().execute(
        'Grep',
        { pattern: PROD_SENTINEL, path: fakeHome },
        { sessionId: 'slot-isolation-grep-system' },
      );
      expectNoForeignLeak(result, PROD_SENTINEL, prodFile);
      expect(result.error ?? '').not.toContain('另一个槽');
    } finally {
      __setRgBinaryPathForTest(undefined);
    }
  });

  it('兄弟槽做成指向别处的软链，读它仍被拒', async () => {
    const elsewhere = mkdtempSync(path.join(os.tmpdir(), 'slot-isolation-elsewhere-'));
    try {
      mkdirSync(path.join(elsewhere, 'memory'), { recursive: true });
      writeFileSync(path.join(elsewhere, 'memory', 'notes.md'), PROD_SENTINEL);
      writeFileSync(path.join(elsewhere, 'config.json'), `{"secret":"${PROD_SENTINEL}"}`);
      rmSync(prodSlot, { recursive: true, force: true });
      symlinkSync(elsewhere, prodSlot);

      const result = await buildExecutor().execute(
        'Read',
        { file_path: path.join(prodSlot, 'memory', 'notes.md') },
        { sessionId: 'slot-isolation-symlink' },
      );
      expectForeignDenied(result, '.code-agent', PROD_SENTINEL);
      expectNoForeignLeak(result, PROD_SENTINEL, path.join(prodSlot, 'memory', 'notes.md'));
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('真阴：当前槽递归 Glob/Grep 自己仍成功', async () => {
    const globResult = await buildExecutor().execute(
      'Glob',
      { pattern: '**/*', path: devSlot },
      { sessionId: 'slot-isolation-own-glob' },
    );
    expect(globResult.success).toBe(true);
    expect(leakedText(globResult)).toContain('memory/notes.md');
    expect(globResult.error ?? '').not.toContain('另一个槽');

    const grepResult = await buildExecutor().execute(
      'Grep',
      { pattern: OWN_SENTINEL, path: devSlot },
      { sessionId: 'slot-isolation-own-grep' },
    );
    expect(grepResult.success).toBe(true);
    expect(leakedText(grepResult)).toContain(OWN_SENTINEL);
    expect(grepResult.error ?? '').not.toContain('另一个槽');
  });

  it('前缀陷阱：.code-agent 不是 .code-agent-dev 的父槽', () => {
    const asProd = evaluateSlotDataDirAccess(path.join(devSlot, 'memory', 'notes.md'), {
      currentDataDir: prodSlot,
      homeDirs: [fakeHome],
    });
    expect(asProd.allowed).toBe(false);
    if (!asProd.allowed) expect(asProd.slotName).toBe('.code-agent-dev');

    const asDev = evaluateSlotDataDirAccess(path.join(devSlot, 'memory', 'notes.md'), {
      currentDataDir: devSlot,
      homeDirs: [fakeHome],
    });
    expect(asDev.allowed).toBe(true);
  });
});
