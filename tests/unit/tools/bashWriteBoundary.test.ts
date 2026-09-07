// ============================================================================
// N-EVAL-POLICY-WRITE-BOUNDARY-ENABLE2 · 缺口②：Bash 路写目标边界（开关门内）
// ============================================================================
// 存量闸把 bash 排除在写目标判定外（#1686「Bash 一类：本单不做」）。本单在
// restrictWritesToWorkspace 开着时接上 shellWriteTargets 派生链。判据锚真实落盘：
// - 越界重定向 / tee / cp：拒且不落盘（拦截面：`>`/`>>` 重定向 + cp/mv/tee 目标位）
// - 沙箱内相对路径 / working_directory 锚定 / 记忆目录（第二可写根）：放行且真落盘
// - 🔴 开关关着：同一命令不被这道闸拦（与改前一字不差），照常执行落盘
// ============================================================================

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/host/tools/shell/dynamicDescription', () => ({
  generateBashDescription: async () => null,
}));

// 缺口③留痕钉：捕获 ToolExecutor 的 warn（放行+留痕口径的「档」），转发原 logger 不吞日志。
const loggerWarnCalls = vi.hoisted(() => [] as unknown[][]);
vi.mock('../../../src/host/services/infra/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/services/infra/logger')>();
  return {
    ...actual,
    createLogger: (context: string) => {
      const base = actual.createLogger(context);
      // Logger 是 class（方法在原型上，spread 会丢）：显式绑方法，只拦 warn。
      return {
        debug: base.debug.bind(base),
        info: base.info.bind(base),
        warn: (...args: Parameters<typeof base.warn>) => {
          if (context === 'ToolExecutor') loggerWarnCalls.push(args);
          return base.warn(...args);
        },
        error: base.error.bind(base),
        setLevel: base.setLevel.bind(base),
        dispose: base.dispose.bind(base),
      } as unknown as ReturnType<typeof actual.createLogger>;
    },
  };
});

import { getToolCache } from '../../../src/host/services/infra/toolCache';
import { fileReadTracker } from '../../../src/host/tools/fileReadTracker';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import { createRunContext } from '../../../src/host/runtime/runContext';
import { createWorkspaceScope } from '../../../src/host/runtime/workspaceScope';

describe('Bash 写目标边界（restrictWritesToWorkspace 开关门内）', () => {
  let parent: string;
  let sandbox: string;
  let outside: string;
  let memoryDir: string;
  const cleanupRoots: string[] = [];
  let previousDataDir: string | undefined;

  beforeAll(() => { getProtocolRegistry(); });

  beforeEach(async () => {
    loggerWarnCalls.length = 0;
    parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bash-wsb-')));
    cleanupRoots.push(parent);
    sandbox = path.join(parent, 'a-sandbox');
    outside = path.join(parent, 'z-outside');
    memoryDir = path.join(parent, 'data', 'memory');
    await fs.mkdir(sandbox);
    await fs.mkdir(outside);
    await fs.mkdir(memoryDir, { recursive: true });
    previousDataDir = process.env.CODE_AGENT_DATA_DIR;
    process.env.CODE_AGENT_DATA_DIR = path.join(parent, 'data');
    getToolCache().clear();
    fileReadTracker.clear();
    resetPermissionModeManager();
  });

  afterEach(async () => {
    resetPermissionModeManager();
    if (previousDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = previousDataDir;
    for (const root of cleanupRoots.splice(0)) {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  /** 评测形状的 executor：双根 scope（沙箱 primary + 记忆 additional）。
   *  restrict=true 时挂 runContext；false 时连 runContext 都没有（= 评测关着开关的形状）。 */
  function buildExecutor(restrict: boolean): ToolExecutor {
    const scope = createWorkspaceScope('bash-wsb-project', [
      { sourceId: 'eval-sandbox', path: sandbox, role: 'primary', access: 'read_write' },
      { sourceId: 'eval-memory', path: memoryDir, role: 'additional', access: 'read_write' },
    ]);
    const runContext = createRunContext({
      runId: 'bash-wsb-run',
      sessionId: 'bash-wsb-session',
      workspace: sandbox,
      cwd: sandbox,
      workspaceScope: scope,
    });
    const executor = new ToolExecutor({
      // 审批一律放行：要证明的是「边界拦住了」，不是「审批拦住了」。
      requestPermission: async () => true,
      workingDirectory: sandbox,
      ledgerOrigin: 'eval',
      ...(restrict ? { restrictWritesToWorkspace: true, runContext } : {}),
    });
    executor.setAuditEnabled(false);
    return executor;
  }

  function runBash(executor: ToolExecutor, command: string, workingDirectory?: string) {
    return executor.execute('Bash', {
      command,
      ...(workingDirectory ? { working_directory: workingDirectory } : {}),
    }, { sessionId: 'bash-wsb-session' });
  }

  it('开着：越界重定向 `>` 拒且不落盘', async () => {
    const target = path.join(outside, 'redirect-escape.txt');
    const result = await runBash(buildExecutor(true), `echo wsb > ${target}`);
    expect(result.success).toBe(false);
    expect(result.metadata?.code).toBe('PROJECT_SOURCE_OUTSIDE_WORKSPACE');
    expect(existsSync(target)).toBe(false);
  });

  it('开着：越界追加重定向 `>>` 拒且不落盘', async () => {
    const target = path.join(outside, 'append-escape.txt');
    const result = await runBash(buildExecutor(true), `echo wsb >> ${target}`);
    expect(result.success).toBe(false);
    expect(result.metadata?.code).toBe('PROJECT_SOURCE_OUTSIDE_WORKSPACE');
    expect(existsSync(target)).toBe(false);
  });

  it('开着：管道 tee 越界目标拒且不落盘', async () => {
    const target = path.join(outside, 'tee-escape.txt');
    const result = await runBash(buildExecutor(true), `echo wsb | tee ${target}`);
    expect(result.success).toBe(false);
    expect(result.metadata?.code).toBe('PROJECT_SOURCE_OUTSIDE_WORKSPACE');
    expect(existsSync(target)).toBe(false);
  });

  it('开着：cp 目标位越界拒且不落盘', async () => {
    const source = path.join(sandbox, 'src.txt');
    await fs.writeFile(source, 'wsb');
    const target = path.join(outside, 'cp-escape.txt');
    const result = await runBash(buildExecutor(true), `cp ${source} ${target}`);
    expect(result.success).toBe(false);
    expect(result.metadata?.code).toBe('PROJECT_SOURCE_OUTSIDE_WORKSPACE');
    expect(existsSync(target)).toBe(false);
  });

  it('开着：working_directory 子目录里 `..` 相对逃逸拒且不落盘', async () => {
    const sub = path.join(sandbox, 'sub');
    await fs.mkdir(sub);
    const target = path.join(outside, 'dotdot-escape.txt');
    // 从 sub 出发要两级 `..` 才出沙箱（一级只到 a-sandbox/z-outside，还在界内）
    const result = await runBash(buildExecutor(true), 'echo wsb > ../../z-outside/dotdot-escape.txt', sub);
    expect(result.success).toBe(false);
    expect(result.metadata?.code).toBe('PROJECT_SOURCE_OUTSIDE_WORKSPACE');
    expect(existsSync(target)).toBe(false);
  });

  it('开着：沙箱内相对重定向放行且真落盘（锚会话 cwd）', async () => {
    const result = await runBash(buildExecutor(true), 'echo wsb > inside.txt');
    expect(result.success).toBe(true);
    expect(existsSync(path.join(sandbox, 'inside.txt'))).toBe(true);
  });

  it('开着：带空格的引号越界目标按完整路径判，拒且不落盘（PR #1709 复审①）', async () => {
    // 复审①的精确形状：真实目标是沙箱的同级兄弟 `"${sandbox} escape.txt"`（界外）。
    // 修复前分词先去引号再截断在空格 ⇒ 闸看到的只剩 ${sandbox}（界内）⇒ 放行，
    // 真实 bash 写的是界外兄弟文件——静默绕过。截断必须落在界内才咬得住这条。
    const target = `${sandbox} escape.txt`;
    const result = await runBash(buildExecutor(true), `echo wsb > "${target}"`);
    expect(result.success).toBe(false);
    expect(result.metadata?.code).toBe('PROJECT_SOURCE_OUTSIDE_WORKSPACE');
    expect(existsSync(target)).toBe(false);
  });

  it('开着：带空格的引号界内目标放行且真落盘（PR #1709 复审①对照面）', async () => {
    const target = path.join(sandbox, 'quoted ok.txt');
    const result = await runBash(buildExecutor(true), `echo wsb > "${target}"`);
    expect(result.success).toBe(true);
    expect(existsSync(target)).toBe(true);
  });

  it('开着：字符串字面量里的 `>` 不误判为写目标，printf 照常执行（PR #1709 复审①假阳性面）', async () => {
    const literalTarget = path.join(outside, 'literal-not-a-write.txt');
    const result = await runBash(buildExecutor(true), `printf '%s\\n' '>${literalTarget}'`);
    expect(result.success).toBe(true);
    expect(existsSync(literalTarget)).toBe(false);
  });

  it('开着：working_directory 子目录里相对重定向放行且落在该子目录（锚 working_directory）', async () => {
    const sub = path.join(sandbox, 'sub');
    await fs.mkdir(sub);
    const result = await runBash(buildExecutor(true), 'echo wsb > rel.txt', sub);
    expect(result.success).toBe(true);
    // 锚错了会落进 sandbox 根：锚 working_directory 才算对
    expect(existsSync(path.join(sub, 'rel.txt'))).toBe(true);
    expect(existsSync(path.join(sandbox, 'rel.txt'))).toBe(false);
  });

  it('开着：重定向进记忆目录（第二可写根）放行且真落盘', async () => {
    const target = path.join(memoryDir, 'bash-log.txt');
    const result = await runBash(buildExecutor(true), `echo wsb >> ${target}`);
    expect(result.success).toBe(true);
    expect(existsSync(target)).toBe(true);
  });

  it('开着：`2>/dev/null` 惯用法放行（/dev/null 豁免——真跑 26/101 次 bash 调用带它）', async () => {
    const result = await runBash(buildExecutor(true), 'ls . 2>/dev/null');
    expect(result.metadata?.code).not.toBe('PROJECT_SOURCE_OUTSIDE_WORKSPACE');
    expect(result.success).toBe(true);
  });

  it('开着：真越界写与 /dev/null 混在同一条命令里仍拒（豁免只让空汇过，不让真目标过）', async () => {
    const target = path.join(outside, 'mix-escape.txt');
    const result = await runBash(buildExecutor(true), `ls . 2>/dev/null; echo wsb > ${target}`);
    expect(result.success).toBe(false);
    expect(result.metadata?.code).toBe('PROJECT_SOURCE_OUTSIDE_WORKSPACE');
    expect(existsSync(target)).toBe(false);
  });

  // =========================================================================
  // 缺口③：uncertain 写目标口径 = 放行 + 留痕（数据驱动，见证据档缺口③节）
  // =========================================================================
  it('开着：变量重定向目标（uncertain-redirection）放行且留痕 warn——不拒', async () => {
    const result = await runBash(buildExecutor(true), 'echo wsb > out$UNSET_VAR.txt');
    expect(result.metadata?.code).not.toBe('PROJECT_SOURCE_OUTSIDE_WORKSPACE');
    expect(result.success).toBe(true);
    // 留痕（独立档）：warn 必须带 uncertain 原文，事后可从运行日志数出来
    const flat = JSON.stringify(loggerWarnCalls);
    expect(flat).toContain('uncertain-redirection');
    expect(flat).toContain('out$UNSET_VAR.txt');
  });

  it('开着：python heredoc 体内的 `>` 伪影（真跑实测的主要 uncertain 构成）放行不拒', async () => {
    // 真跑数据形状：python3 - <<EOF 体里的 `if 1 > 0:` 被分词器当重定向，目标 `0` 相对
    // 锚进沙箱；uncertain/伪影目标都不能把合法修复流打成假阴性（excel-bench-59196 实测）。
    const result = await runBash(buildExecutor(true), "python3 - <<'PYEOF'\nif 1 > 0:\n    print('ok')\nPYEOF");
    expect(result.metadata?.code).not.toBe('PROJECT_SOURCE_OUTSIDE_WORKSPACE');
    expect(result.success).toBe(true);
  });

  it('开着：空路径位参数（uncertain:<param> 良性形状）放行不拒', async () => {
    const result = await runBash(buildExecutor(true), 'ls', '');
    expect(result.metadata?.code).not.toBe('PROJECT_SOURCE_OUTSIDE_WORKSPACE');
    expect(result.success).toBe(true);
  });

  it('🔴 关着：同一越界重定向不被这道闸拦，照常执行落盘（与改前一字不差）', async () => {
    const target = path.join(outside, 'off-escape.txt');
    const result = await runBash(buildExecutor(false), `echo wsb > ${target}`);
    expect(result.metadata?.code).not.toBe('PROJECT_SOURCE_OUTSIDE_WORKSPACE');
    expect(existsSync(target)).toBe(true);
  });

  it('🔴 关着：uncertain 不判定、不留痕（warn 只在开关开着时发）', async () => {
    const result = await runBash(buildExecutor(false), 'echo wsb > out$UNSET_VAR.txt');
    expect(result.metadata?.code).not.toBe('PROJECT_SOURCE_OUTSIDE_WORKSPACE');
    expect(JSON.stringify(loggerWarnCalls)).not.toContain('uncertain-redirection');
  });
});
