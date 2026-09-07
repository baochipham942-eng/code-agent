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
  collectForeignSlotTraversalExcludes,
  evaluateToolSlotDataDirAccess,
  FOREIGN_SLOT_DATA_DIR_CODE,
  foreignSlotPrunedGrepSearchPaths,
} from '../../src/host/security/slotDataDirGuard';

const CROSS_SLOT_READ_ALLOW_ENV = 'CODE_AGENT_ALLOW_CROSS_SLOT_READ';
const CROSS_SLOT_READ_ALLOWLIST_ENV = 'CODE_AGENT_CROSS_SLOT_READ_ALLOWLIST';
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
    const target = path.join(devSlot, 'memory', 'notes.md');
    const asProd = evaluateToolSlotDataDirAccess(
      'Read',
      { file_path: target },
      fakeHome,
      { currentDataDir: prodSlot, homeDirs: [fakeHome] },
    );
    expect(asProd.allowed).toBe(false);
    if (!asProd.allowed) expect(asProd.slotName).toBe('.code-agent-dev');

    const asDev = evaluateToolSlotDataDirAccess(
      'Read',
      { file_path: target },
      fakeHome,
      { currentDataDir: devSlot, homeDirs: [fakeHome] },
    );
    expect(asDev.allowed).toBe(true);
  });

  it('Glob 相对 pattern 相对搜索根解析，不把 .code-agent/* 当成家目录槽', () => {
    const projectRoot = path.join(fakeHome, 'projects', 'demo');
    mkdirSync(path.join(projectRoot, '.code-agent'), { recursive: true });
    writeFileSync(path.join(projectRoot, '.code-agent', 'agents.json'), '{}');
    const verdict = evaluateToolSlotDataDirAccess(
      'Glob',
      { path: projectRoot, pattern: '.code-agent/*.json' },
      fakeHome,
      { currentDataDir: devSlot, homeDirs: [fakeHome] },
    );
    expect(verdict.allowed).toBe(true);
  });

  // --------------------------------------------------------------------------
  // 第二轮返修（R2 四条）：入口判据在执行时失效的漏网
  // --------------------------------------------------------------------------

  it('R2① 当前槽内的软链指向生产槽：读它被拒，字面路径在当前槽救不了它', async () => {
    symlinkSync(prodSlot, path.join(devSlot, 'prod'));
    try {
      const result = await buildExecutor().execute(
        'Read',
        { file_path: path.join(devSlot, 'prod', 'memory', 'notes.md') },
        { sessionId: 'slot-isolation-r2-symlink-in-own' },
      );
      expectForeignDenied(result, '.code-agent', PROD_SENTINEL);
      expectNoForeignLeak(result, PROD_SENTINEL, prodFile);
    } finally {
      rmSync(path.join(devSlot, 'prod'), { force: true });
    }
  });

  it('R2③ 子 shell 的 cd 不外溢：(cd /tmp); cat 生产槽相对路径被拒', async () => {
    const result = await buildExecutor().execute(
      'Bash',
      { command: '(cd /tmp); cat .code-agent/memory/notes.md', working_directory: fakeHome },
      { sessionId: 'slot-isolation-r2-subshell-cd-no-leak' },
    );
    expectForeignDenied(result, '.code-agent', PROD_SENTINEL);
    expectNoForeignLeak(result, PROD_SENTINEL, prodFile);
  });

  it('R2③ 真阴：子 shell 的 cd 不外溢，外层读当前槽相对路径照常成功', async () => {
    const result = await buildExecutor().execute(
      'Bash',
      { command: '(cd /tmp); cat .code-agent-dev/memory/notes.md', working_directory: fakeHome },
      { sessionId: 'slot-isolation-r2-subshell-cd-own' },
    );
    expect(result.success).toBe(true);
    expect(leakedText(result)).toContain(OWN_SENTINEL);
    expect(result.error ?? '').not.toContain('另一个槽');
  });

  it('R2③ 花括号分组不建子 shell：cd 外溢后按外层语义判，仍拒生产槽', async () => {
    const result = await buildExecutor().execute(
      'Bash',
      { command: '{ cd "$HOME"; }; cat .code-agent/memory/notes.md', working_directory: fakeHome },
      { sessionId: 'slot-isolation-r2-brace-cd-leaks' },
    );
    expectForeignDenied(result, '.code-agent', PROD_SENTINEL);
  });

  it('R2② Bash 里 grep -r 整个 home：跨槽内容不能到达调用方', async () => {
    const result = await buildExecutor().execute(
      'Bash',
      { command: `grep -r ${PROD_SENTINEL} "$HOME"` },
      { sessionId: 'slot-isolation-r2-bash-grep-r-home' },
    );
    expect(leakedText(result), 'Bash 递归读不能带回生产槽内容').not.toContain(PROD_SENTINEL);
    expect(result.success).toBe(false);
    expect(result.error ?? '').toMatch(/这是另一个槽（\.code-agent(-chatprobe)?）的数据目录/);
    expect(result.metadata?.code).toBe(FOREIGN_SLOT_DATA_DIR_CODE);
  });

  it('R2② 真阴：Bash 里 grep -r 项目目录（下面没有别人的槽）照常返回匹配', async () => {
    const projectSentinel = 'SLOT_ISOLATION_PROJECT_MATCH_5d17';
    const hitDir = path.join(projectDir, 'searchable');
    mkdirSync(hitDir, { recursive: true });
    writeFileSync(path.join(hitDir, 'notes.txt'), projectSentinel);

    const result = await buildExecutor().execute(
      'Bash',
      { command: `grep -r ${projectSentinel} .` },
      { sessionId: 'slot-isolation-r2-bash-grep-r-project' },
    );
    expect(result.success).toBe(true);
    expect(leakedText(result)).toContain(projectSentinel);
    expect(result.error ?? '').not.toContain('另一个槽');
  });

  // ------------------------------------------------------------------------
  // 第三轮（R3 三条）：字符串分析与真实 shell 语义的三个盲区
  // ------------------------------------------------------------------------

  it('R3① 软链+..：cat <指向生产槽memory的软链>/../config.json 被拒（内核先解软链再走 ..）', async () => {
    symlinkSync(path.join(prodSlot, 'memory'), path.join(devSlot, 'prodmem'));
    try {
      // 不能用 path.join 拼：它会把 .. 词法塌缩掉，攻击串里就没剩 .. 了。
      const attack = [devSlot, 'prodmem', '..', 'config.json'].join('/');
      const result = await buildExecutor().execute(
        'Bash',
        { command: `cat ${JSON.stringify(attack)}` },
        { sessionId: 'slot-isolation-r3-symlink-dotdot' },
      );
      expectForeignDenied(result, '.code-agent', PROD_SENTINEL);
      expectNoForeignLeak(result, PROD_SENTINEL, prodFile);
    } finally {
      rmSync(path.join(devSlot, 'prodmem'), { force: true });
    }
  });

  it('R3① 真阴：软链指向当前槽 + .. 照常读到自己的文件', async () => {
    symlinkSync(path.join(devSlot, 'memory'), path.join(devSlot, 'ownmem'));
    try {
      const attack = [devSlot, 'ownmem', '..', 'memory', 'notes.md'].join('/');
      const result = await buildExecutor().execute(
        'Bash',
        { command: `cat ${JSON.stringify(attack)}` },
        { sessionId: 'slot-isolation-r3-symlink-dotdot-own' },
      );
      expect(result.success).toBe(true);
      expect(leakedText(result)).toContain(OWN_SENTINEL);
      expect(result.error ?? '').not.toContain('另一个槽');
    } finally {
      rmSync(path.join(devSlot, 'ownmem'), { force: true });
    }
  });

  it('R3② ${HOME} 参数展开不被当成花括号分组拆碎：cat ${HOME}/.code-agent/config.json 被拒', async () => {
    const result = await buildExecutor().execute(
      'Bash',
      { command: 'cat ${HOME}/.code-agent/config.json' },
      { sessionId: 'slot-isolation-r3-home-brace-expansion' },
    );
    expectForeignDenied(result, '.code-agent', PROD_SENTINEL);
    expectNoForeignLeak(result, PROD_SENTINEL, prodFile);
  });

  it('R3② 真阴：${HOME} 展开后读当前槽文件照常成功', async () => {
    const result = await buildExecutor().execute(
      'Bash',
      { command: 'cat ${HOME}/.code-agent-dev/memory/notes.md' },
      { sessionId: 'slot-isolation-r3-home-brace-expansion-own' },
    );
    expect(result.success).toBe(true);
    expect(leakedText(result)).toContain(OWN_SENTINEL);
    expect(result.error ?? '').not.toContain('另一个槽');
  });

  it('R3③ 条件分支里的 cd 不算数：cd "$HOME"; true || cd /tmp; cat .code-agent/config.json 被拒', async () => {
    const result = await buildExecutor().execute(
      'Bash',
      { command: 'cd "$HOME"; true || cd /tmp; cat .code-agent/config.json' },
      { sessionId: 'slot-isolation-r3-dead-branch-cd' },
    );
    expectForeignDenied(result, '.code-agent', PROD_SENTINEL);
    expectNoForeignLeak(result, PROD_SENTINEL, prodFile);
  });

  it('R3③ 真阴：条件分支 cd 不算数时读当前槽相对路径照常成功', async () => {
    const result = await buildExecutor().execute(
      'Bash',
      { command: 'cd "$HOME"; true || cd /tmp; cat .code-agent-dev/memory/notes.md' },
      { sessionId: 'slot-isolation-r3-dead-branch-cd-own' },
    );
    expect(result.success).toBe(true);
    expect(leakedText(result)).toContain(OWN_SENTINEL);
    expect(result.error ?? '').not.toContain('另一个槽');
  });

  // ------------------------------------------------------------------------
  // 第四轮（R4 两条）：path.join 提前塌缩 ..、grep -f 模式文件——换共享解析器收口
  // ------------------------------------------------------------------------

  it('R4① 相对路径软链+..：项目内 prodmem 指向生产槽 memory，cat prodmem/../config.json 被拒', async () => {
    symlinkSync(path.join(prodSlot, 'memory'), path.join(projectDir, 'prodmem'));
    try {
      const result = await buildExecutor().execute(
        'Bash',
        { command: 'cat "prodmem/../config.json"' },
        { sessionId: 'slot-isolation-r4-relative-symlink-dotdot' },
      );
      expectForeignDenied(result, '.code-agent', PROD_SENTINEL);
      expectNoForeignLeak(result, PROD_SENTINEL, path.join(prodSlot, 'config.json'));
    } finally {
      rmSync(path.join(projectDir, 'prodmem'), { force: true });
    }
  });

  it('R4① Read 工具相对路径同样被拒：file_path=prodmem/../config.json', async () => {
    symlinkSync(path.join(prodSlot, 'memory'), path.join(projectDir, 'prodmem'));
    try {
      const result = await buildExecutor().execute(
        'Read',
        { file_path: 'prodmem/../config.json' },
        { sessionId: 'slot-isolation-r4-read-relative-symlink-dotdot' },
      );
      expectForeignDenied(result, '.code-agent', PROD_SENTINEL);
    } finally {
      rmSync(path.join(projectDir, 'prodmem'), { force: true });
    }
  });

  it('R4① 真阴：项目内软链指向当前槽 + .. 照常读到自己的文件', async () => {
    symlinkSync(path.join(devSlot, 'memory'), path.join(projectDir, 'ownmem'));
    try {
      const result = await buildExecutor().execute(
        'Bash',
        { command: 'cat "ownmem/../memory/notes.md"' },
        { sessionId: 'slot-isolation-r4-own-relative-symlink-dotdot' },
      );
      expect(result.success).toBe(true);
      expect(leakedText(result)).toContain(OWN_SENTINEL);
      expect(result.error ?? '').not.toContain('另一个槽');
    } finally {
      rmSync(path.join(projectDir, 'ownmem'), { force: true });
    }
  });

  it('R4② grep -f 模式文件顶掉 pattern 位：grep -r -f patterns.txt "$HOME" 整条被拒', async () => {
    writeFileSync(path.join(projectDir, 'patterns.txt'), 'memory\n');
    try {
      const result = await buildExecutor().execute(
        'Bash',
        { command: 'grep -r -f patterns.txt "$HOME"' },
        { sessionId: 'slot-isolation-r4-grep-f-home' },
      );
      expectForeignDenied(result, '.code-agent', PROD_SENTINEL);
      expectNoForeignLeak(result, PROD_SENTINEL, path.join(prodSlot, 'config.json'));
    } finally {
      rmSync(path.join(projectDir, 'patterns.txt'), { force: true });
    }
  });

  it('R4② 真阴：grep -r -f patterns.txt . 搜项目目录照常返回匹配', async () => {
    writeFileSync(path.join(projectDir, 'patterns.txt'), 'r4-needle\n');
    writeFileSync(path.join(projectDir, 'haystack.txt'), 'r4-needle in project\n');
    try {
      const result = await buildExecutor().execute(
        'Bash',
        { command: 'grep -r -f patterns.txt .' },
        { sessionId: 'slot-isolation-r4-grep-f-dot' },
      );
      expect(result.success).toBe(true);
      expect(leakedText(result)).toContain('r4-needle in project');
      expect(result.error ?? '').not.toContain('另一个槽');
    } finally {
      rmSync(path.join(projectDir, 'patterns.txt'), { force: true });
      rmSync(path.join(projectDir, 'haystack.txt'), { force: true });
    }
  });

  it('R4 换解析器附带：bash -c 内相对 cd 进软链读生产槽被拒（旧手写链漏）', async () => {
    symlinkSync(prodSlot, path.join(projectDir, 'prodroot'));
    try {
      const result = await buildExecutor().execute(
        'Bash',
        { command: 'bash -c \'cd prodroot && cat config.json\'' },
        { sessionId: 'slot-isolation-r4-bash-c-relative-cd' },
      );
      expectForeignDenied(result, '.code-agent', PROD_SENTINEL);
      expectNoForeignLeak(result, PROD_SENTINEL, path.join(prodSlot, 'config.json'));
    } finally {
      rmSync(path.join(projectDir, 'prodroot'), { force: true });
    }
  });

  it('R2④ rg 不可用时从 home 父目录搜：普通项目匹配照常返回，槽内容被排除', async () => {
    // 同一个哨兵串既写进生产槽文件也写进普通项目文件：排除项只能按路径区分，
    // 修好前系统 grep 会把整个 home 目录名当排除项，普通项目的匹配一起被静默丢掉。
    const shared = 'SLOT_ISOLATION_R2_SHARED_MATCH_8e42';
    const root = mkdtempSync(path.join(os.tmpdir(), 'slot-isolation-root-'));
    try {
      const nestedHome = path.join(root, 'home');
      const nestedProd = path.join(nestedHome, '.code-agent');
      const nestedDev = path.join(nestedHome, '.code-agent-dev');
      const nestedProject = path.join(nestedHome, 'projects', 'demo');
      mkdirSync(path.join(nestedProd, 'memory'), { recursive: true });
      mkdirSync(path.join(nestedDev, 'memory'), { recursive: true });
      mkdirSync(nestedProject, { recursive: true });
      writeFileSync(path.join(nestedProd, 'memory', 'notes.md'), shared);
      writeFileSync(path.join(nestedDev, 'memory', 'notes.md'), OWN_SENTINEL);
      writeFileSync(path.join(nestedProject, 'notes.txt'), shared);

      vi.stubEnv('HOME', nestedHome);
      vi.stubEnv('CODE_AGENT_HOME', nestedHome);
      vi.stubEnv('CODE_AGENT_DATA_DIR', nestedDev);
      __setRgBinaryPathForTest(null);
      try {
        const result = await buildExecutor().execute(
          'Grep',
          { pattern: shared, path: root },
          { sessionId: 'slot-isolation-r2-grep-from-home-parent' },
        );
        expect(result.success).toBe(true);
        const text = discoveryLeakText(result);
        expect(text, '普通项目的匹配不能被槽排除项误伤').toContain('projects/demo');
        expect(text, '普通项目的匹配要带着哨兵串回来').toContain(shared);
        expect(text, '生产槽的匹配不能到达调用方').not.toContain('.code-agent/memory');
        expect(text).not.toContain(`${path.sep}.code-agent${path.sep}`);
      } finally {
        __setRgBinaryPathForTest(undefined);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ------------------------------------------------------------------------
  // 第五轮（R5 Important）：grep 排除按真实路径，不按目录名
  // ------------------------------------------------------------------------

  it('R5 项目内同名 .code-agent 配置目录不再被槽排除项误伤（rg 与系统 grep 两个引擎）', async () => {
    // 同一个哨兵串既在生产槽也在项目内 .code-agent 配置里：从 home 搜，前者必须被
    // 排除、后者必须能搜到。修好前系统 grep 拿 --exclude-dir=.code-agent 当排除项，
    // 按目录基名在任意深度匹配（槽根是 home 直接子目录时曾被判定为"精确"），项目
    // 配置一起被静默丢掉，调用方据此误判"配置不存在"。
    const projectCfg = path.join(fakeHome, 'projects', 'demo', '.code-agent', 'agents.json');
    mkdirSync(path.dirname(projectCfg), { recursive: true });
    writeFileSync(projectCfg, `{"agents":"${PROD_SENTINEL}"}`);

    const assertProjectCfgSearchable = (result: ToolExecutionResult): void => {
      expect(result.success).toBe(true);
      const text = discoveryLeakText(result);
      expect(text, '项目内 .code-agent 配置必须搜得到').toContain('projects/demo');
      expect(text, '匹配要带着哨兵串回来').toContain(PROD_SENTINEL);
      // 哨兵串同时存在于生产槽：泄漏判据咬生产槽根路径，不能咬哨兵串本身。
      expect(text, '生产槽路径（及其内容行）不能到达调用方').not.toContain(prodSlot);
    };

    const rgResult = await buildExecutor().execute(
      'Grep',
      { pattern: PROD_SENTINEL, path: fakeHome },
      { sessionId: 'slot-isolation-r5-projcfg-rg' },
    );
    assertProjectCfgSearchable(rgResult);

    __setRgBinaryPathForTest(null);
    try {
      const grepResult = await buildExecutor().execute(
        'Grep',
        { pattern: PROD_SENTINEL, path: fakeHome },
        { sessionId: 'slot-isolation-r5-projcfg-sysgrep' },
      );
      assertProjectCfgSearchable(grepResult);
    } finally {
      __setRgBinaryPathForTest(undefined);
    }
  });

  it('R5 排除项不按目录名：excludes 不再有 excludeDirNames，剪枝搜索根按路径排除别人槽', () => {
    mkdirSync(path.join(fakeHome, 'projects', 'demo', '.code-agent'), { recursive: true });
    const options = { currentDataDir: devSlot, homeDirs: [fakeHome] };

    const excludes = collectForeignSlotTraversalExcludes(fakeHome, options);
    expect('excludeDirNames' in excludes).toBe(false);
    expect(excludes.roots.map((root) => path.resolve(root))).toContain(path.resolve(prodSlot));
    expect(excludes.ignoreGlobs).toContain('.code-agent/**');

    const pruned = foreignSlotPrunedGrepSearchPaths(fakeHome, options);
    expect(pruned, '别人槽的直接子项按路径剪掉').not.toContain(path.resolve(prodSlot));
    expect(pruned, '当前槽照常可搜').toContain(path.resolve(devSlot));
    expect(pruned, '项目目录照常可搜').toContain(path.resolve(fakeHome, 'projects'));
    expect(pruned, '剪枝结果是子项列表，不含搜索根本身').not.toContain(path.resolve(fakeHome));

    // 指向别人槽的软链子项按真实路径剪掉（判据是路径，不是名字）。
    symlinkSync(prodSlot, path.join(fakeHome, 'linkprod'));
    try {
      expect(foreignSlotPrunedGrepSearchPaths(fakeHome, options)).not.toContain(path.resolve(fakeHome, 'linkprod'));
    } finally {
      rmSync(path.join(fakeHome, 'linkprod'), { force: true });
    }

    // 搜索根下没有别人槽时原样返回，不做任何枚举。
    expect(foreignSlotPrunedGrepSearchPaths(projectDir, options)).toEqual([path.resolve(projectDir)]);
  });

  // ------------------------------------------------------------------------
  // 第五轮（R5 Nit）：fail-closed / 条件 cd 候选枚举加预算，超限拒绝
  // ------------------------------------------------------------------------

  it('R5 Nit：解析失败 + 相对 cd 灌满基准预算 → fail-closed 拒绝（不是放行）', () => {
    // 未闭合引号触发解析失败走宽视图；相对 cd 按全部历史基准扩展，基准指数增长。
    const command = 'cd a; cd b; cd c; cd d; cd e; cd f; cd g; cd h; echo "unclosed';
    const verdict = evaluateToolSlotDataDirAccess('Bash', { command }, projectDir, {
      currentDataDir: devSlot,
      homeDirs: [fakeHome],
    });
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toContain('预算');
  });

  it('R5 Nit 真阴：常规解析失败命令的枚举量远够不到预算，照常评估放行', () => {
    const verdict = evaluateToolSlotDataDirAccess('Bash', { command: 'cat notes.txt; echo "unclosed' }, projectDir, {
      currentDataDir: devSlot,
      homeDirs: [fakeHome],
    });
    expect(verdict.allowed).toBe(true);
  });

  it('R5 Nit：预算拒绝经 executor 到达调用方（整条 Bash 命令被拒）', async () => {
    const result = await buildExecutor().execute(
      'Bash',
      { command: 'cd a; cd b; cd c; cd d; cd e; cd f; cd g; cd h; echo "unclosed' },
      { sessionId: 'slot-isolation-r5-budget-executor' },
    );
    expect(result.success).toBe(false);
    expect(result.error ?? '').toContain('预算');
    expect(result.metadata?.code).toBe(FOREIGN_SLOT_DATA_DIR_CODE);
  });
});
