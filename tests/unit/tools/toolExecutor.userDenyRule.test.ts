// ============================================================================
// 用户级 deny 规则在执行链的硬拒（两个工单同题异物，合并保留双方用例）
// ----------------------------------------------------------------------------
// N-PERM-USER-DENY-MAIN（origin/main 21e8ce03e）：设置里写的 deny Bash(rm *) 必须在
// 审批之前硬拒——哪怕审批处理器会点「允许」。此前主拓扑没有任何消费方，rm 落到审批卡，
// 点允许就执行（FB-401 真跑实证）。
// N-PERMRULES-LOCAL-OWNER r1：用户 deny 规则的消费点都不在主链放行捷径之前——已知安全
// 命令白名单、exec-policy allow、lenient 档、skill 预授权全部先放行，非已知安全命令降级
// 成可批的 ask。本文件钉死：用户显式 deny 在所有自动放行捷径与 ask 分类链之前硬拒。
// ============================================================================

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/host/services/infra/logger', () => {
  const fake = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { createLogger: vi.fn(() => fake), logger: fake, default: fake };
});

vi.mock('../../../src/host/tools/shell/dynamicDescription', () => ({
  generateBashDescription: async () => null,
}));

import { execFileSync } from 'node:child_process';
import { getToolCache } from '../../../src/host/services/infra/toolCache';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import type { PermissionRequestData } from '../../../src/host/tools/types';
import { getPermissionClassifier } from '../../../src/host/tools/permissionClassifier';
import { getPolicyEngine, resetPolicyEngine } from '../../../src/host/permissions/policyEngine';
import type { ExecutionTopology } from '../../../src/host/permissions';
import { getPermissionModeManager, resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { getToolLedgerSink, setToolLedgerSink } from '../../../src/host/tools/toolLedgerSink';
import type { PermissionDecisionInput } from '../../../src/host/services/core/repositories/PermissionDecisionRepository';

// N-PERM-USER-DENY-MAIN：设置里写的 deny Bash(rm *) 必须在审批之前硬拒——哪怕审批处理器
// 会点「允许」。此前主拓扑没有任何消费方，rm 落到审批卡，点允许就执行（FB-401 真跑实证）。
describe('ToolExecutor 用户拒绝规则', () => {
  let workspace: string;
  let permissionRequests: PermissionRequestData[];

  beforeAll(() => {
    getProtocolRegistry();
  });

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'user-deny-rule-'));
    await fs.writeFile(path.join(workspace, 'victim.txt'), 'keep\n', 'utf8');
    permissionRequests = [];
    resetPolicyEngine();
    getToolCache().clear();
  });

  afterEach(async () => {
    resetPolicyEngine();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  function approvingExecutor(topology: ExecutionTopology = 'main'): ToolExecutor {
    const executor = new ToolExecutor({
      workingDirectory: workspace,
      executionTopology: topology,
      requestPermission: async (request) => {
        permissionRequests.push(request);
        return true;
      },
    });
    executor.setAuditEnabled(false);
    return executor;
  }

  it.each<ExecutionTopology>(['main', 'async_agent'])('%s 拓扑：deny Bash(rm *) 在审批前拒绝 rm，文件保留、零审批卡', async (topology) => {
    getPolicyEngine().loadUserRules({ deny: ['Bash(rm *)'] }, 'user-ui');
    const result = await approvingExecutor(topology).execute(
      'Bash',
      { command: 'rm victim.txt' },
      { sessionId: `user-deny-${topology}` },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Bash(rm *)');
    expect(permissionRequests).toHaveLength(0);
    expect(existsSync(path.join(workspace, 'victim.txt'))).toBe(true);
  });

  it('复合命令里藏着的 rm 同样被拒', async () => {
    getPolicyEngine().loadUserRules({ deny: ['Bash(rm *)'] }, 'user-ui');
    const result = await approvingExecutor().execute(
      'Bash',
      { command: 'ls; rm victim.txt' },
      { sessionId: 'user-deny-compound' },
    );
    expect(result.success).toBe(false);
    expect(existsSync(path.join(workspace, 'victim.txt'))).toBe(true);
  });

  it.each(['plan', 'dontAsk'] as const)('%s 模式下用户 allow 规则不会被当成拒绝规则硬拒', async (mode) => {
    getPolicyEngine().loadUserRules({ allow: ['Bash(printf *)'] }, 'user-ui');
    const modes = getPermissionModeManager();
    const previous = modes.getEffectiveMode();
    expect(modes.setMode(mode, true)).toBe(true);
    expect(modes.getEffectiveMode()).toBe(mode);
    try {
      const result = await approvingExecutor().execute('Bash', { command: 'printf hi' }, { sessionId: `user-allow-${mode}` });
      expect(result.error ?? '').not.toContain('deny rule');
    } finally {
      modes.setMode(previous, true);
    }
  });

  it('无关命令不受 deny 规则影响；没有规则时 rm 走原审批路径', async () => {
    getPolicyEngine().loadUserRules({ deny: ['Bash(rm *)'] }, 'user-ui');
    const listed = await approvingExecutor().execute('Bash', { command: 'ls' }, { sessionId: 'user-deny-unrelated' });
    expect(listed.success).toBe(true);

    resetPolicyEngine();
    const removed = await approvingExecutor().execute('Bash', { command: 'rm victim.txt' }, { sessionId: 'user-deny-none' });
    expect(permissionRequests.length).toBeGreaterThan(0);
    expect(removed.success).toBe(true);
    expect(existsSync(path.join(workspace, 'victim.txt'))).toBe(false);
  });
});

describe('ToolExecutor 用户级 deny 规则硬拒（主 Bash 链）', () => {
  let workspace: string;
  let permissionEvents: PermissionRequestData[];

  beforeAll(() => {
    getProtocolRegistry();
  });

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'user-deny-rule-'));
    permissionEvents = [];
    getToolCache().clear();
    resetPolicyEngine();
    getPermissionClassifier({ enableLlm: false });
    resetPermissionModeManager();
  });

  afterEach(async () => {
    getPermissionClassifier({ enableLlm: false }).clearCache();
    resetPermissionModeManager();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  const createExecutor = () => {
    const executor = new ToolExecutor({
      workingDirectory: workspace,
      requestPermission: async (request) => {
        permissionEvents.push(request);
        return true;
      },
    });
    executor.setAuditEnabled(false);
    return executor;
  };

  it('已知安全命令命中用户 deny 规则：不执行、硬拒文案点名规则、不进审批', async () => {
    getPolicyEngine().loadUserRules({ deny: ['Bash(echo neo-deny-probe*)'] }, 'user-ui');
    const executor = createExecutor();

    const result = await executor.execute('Bash', { command: 'echo neo-deny-probe' }, { sessionId: 'user-deny-known-safe' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('User deny: Bash(echo neo-deny-probe*)');
    // 合并 origin/main 21e8ce03e 后主拓扑先走 guardFabricGate 的硬拒文案（N-PERM-USER-DENY-MAIN）。
    expect(result.error).toContain("denied by the user's settings");
    // 硬拒不是可批的 ask：审批回调一次都不该被叫。
    expect(permissionEvents).toHaveLength(0);
  });

  it('非已知安全命令命中用户 deny 规则：同样硬拒，不降级成 ask/分类器，也不落盘', async () => {
    const target = path.join(os.tmpdir(), `neo-deny-probe-${process.pid}.txt`);
    getPolicyEngine().loadUserRules({ deny: [`Bash(touch ${target}*)`] }, 'user-ui');
    const executor = createExecutor();

    const result = await executor.execute('Bash', { command: `touch ${target}` }, { sessionId: 'user-deny-unsafe' });

    expect(result.success).toBe(false);
    expect(result.error).toContain(`User deny: Bash(touch ${target}*)`);
    expect(permissionEvents).toHaveLength(0);
    await expect(fs.access(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('已知安全命令不命中任何用户 deny 规则：照走安全命令捷径，免审批直接执行', async () => {
    getPolicyEngine().loadUserRules({ deny: ['Bash(echo neo-deny-probe*)'] }, 'user-ui');
    const executor = createExecutor();

    const result = await executor.execute('Bash', { command: 'echo hello' }, { sessionId: 'user-deny-unmatched' });

    expect(result.success).toBe(true);
    expect(permissionEvents).toHaveLength(0);
  });

  it('用户 allow 规则不产生新的放行捷径：非已知安全命令仍走审批后才执行', async () => {
    const target = path.join(workspace, 'neo-allow-probe.txt');
    getPolicyEngine().loadUserRules({ allow: [`Bash(touch ${target}*)`] }, 'user-ui');
    const executor = createExecutor();

    const result = await executor.execute('Bash', { command: `touch ${target}` }, { sessionId: 'user-allow-no-shortcut' });

    expect(permissionEvents).toHaveLength(1);
    expect(result.success).toBe(true);
    await expect(fs.access(target)).resolves.toBeUndefined();
  });
});

// N-PERMRULES-LOCAL-OWNER r4 返修：plan/dontAsk 档 execute 默认 deny，PolicyEngine 会把
// 命中的 user-allow 改写成 action=deny（模式覆盖，policyEngine.ts ~367-374）。执行器层的
// 用户规则硬拒块若信 result.action，用户 allow 在这两档被硬拒成
// 「Blocked by user permission rule … User allow: Bash(…)」且账本 reason 记
// user-permission-rule。硬拒只认 matchedRule 本身是 user-deny（同 guardFabricGate 的
// evaluateUserDeny）；模式改写的 user-allow 原样落回既有模式/审批链。
// 用 git tag 而非任务书字面的 git status 作 allow 样例：内置 allow-git-status（同
// priority 500、稳定排序在前）会抢先成为 matchedRule，user 规则根本轮不上命中，红不出来；
// git tag 不在内置表里，matchedRule 就是 user-allow 本尊。
describe('ToolExecutor 模式改写的 user-allow 不得当成用户 deny 硬拒（r4 返修）', () => {
  let workspace: string;
  let permissionEvents: PermissionRequestData[];
  let appendPermissionDecision: ReturnType<typeof vi.fn<(input: PermissionDecisionInput) => void>>;
  let previousSink: ReturnType<typeof getToolLedgerSink>;

  beforeAll(() => {
    getProtocolRegistry();
  });

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'user-allow-mode-rewrite-'));
    // git status 要真跑通（退出码 0）才能证明落回了既有链而不是被任何一层拦下。
    execFileSync('git', ['init', '--quiet'], { cwd: workspace });
    permissionEvents = [];
    appendPermissionDecision = vi.fn();
    previousSink = getToolLedgerSink();
    getToolCache().clear();
    resetPolicyEngine();
    getPermissionClassifier({ enableLlm: false });
    resetPermissionModeManager();
    setToolLedgerSink({
      appendPermissionDecision,
      appendToolExecutionBegin: vi.fn(),
      appendToolExecutionComplete: vi.fn(),
    });
  });

  afterEach(async () => {
    getPermissionClassifier({ enableLlm: false }).clearCache();
    resetPermissionModeManager();
    setToolLedgerSink(previousSink);
    await fs.rm(workspace, { recursive: true, force: true });
  });

  const createExecutor = () => {
    const executor = new ToolExecutor({
      workingDirectory: workspace,
      requestPermission: async (request) => {
        permissionEvents.push(request);
        return true;
      },
    });
    executor.setAuditEnabled(false);
    return executor;
  };

  const ledgerReasons = () => appendPermissionDecision.mock.calls.map(([entry]) => entry.reason);

  it.each(['plan', 'dontAsk'] as const)('%s 档 user-allow Bash(git tag)：不按用户规则硬拒，落回既有链执行', async (mode) => {
    getPolicyEngine().loadUserRules({ allow: ['Bash(git tag)'] }, 'user-ui');
    const modes = getPermissionModeManager();
    const previous = modes.getEffectiveMode();
    expect(modes.setMode(mode, true)).toBe(true);
    try {
      const result = await createExecutor().execute('Bash', { command: 'git tag' }, { sessionId: `user-allow-${mode}-r4` });

      expect(result.error ?? '').not.toContain('Blocked by user permission rule');
      expect(ledgerReasons()).not.toContain('user-permission-rule');
      // 落回既有链：git tag 是已知安全命令，原链免审批放行（模式改写不改变这条捷径）。
      expect(result.success).toBe(true);
      expect(permissionEvents).toHaveLength(0);
      expect(ledgerReasons()).toContain('safe-command');
    } finally {
      modes.setMode(previous, true);
    }
  });

  it.each(['plan', 'dontAsk'] as const)('%s 档用户 deny Bash(echo neo-deny-probe*) 仍硬拒并点名规则', async (mode) => {
    getPolicyEngine().loadUserRules({ deny: ['Bash(echo neo-deny-probe*)'] }, 'user-ui');
    const modes = getPermissionModeManager();
    const previous = modes.getEffectiveMode();
    expect(modes.setMode(mode, true)).toBe(true);
    try {
      const result = await createExecutor().execute('Bash', { command: 'echo neo-deny-probe' }, { sessionId: `user-deny-${mode}-r4` });

      expect(result.success).toBe(false);
      expect(result.error).toContain('User deny: Bash(echo neo-deny-probe*)');
      expect(permissionEvents).toHaveLength(0);
    } finally {
      modes.setMode(previous, true);
    }
  });

  it('default 档 user-allow Bash(git tag) 不受影响：不硬拒也不进审批', async () => {
    getPolicyEngine().loadUserRules({ allow: ['Bash(git tag)'] }, 'user-ui');
    const result = await createExecutor().execute('Bash', { command: 'git tag' }, { sessionId: 'user-allow-default-r4' });

    expect(result.error ?? '').not.toContain('Blocked by user permission rule');
    expect(ledgerReasons()).not.toContain('user-permission-rule');
    expect(result.success).toBe(true);
    expect(permissionEvents).toHaveLength(0);
  });
});
