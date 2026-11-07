// ============================================================================
// 内置不可覆盖 deny 规则在工具执行闸门的硬拒（N-PERM-RULE-EMPTY-INPUT-MATCH-FU1-FU1，决策 A）
// 只消费 BUILT_IN_RULES 里 !overridable && action==='deny' 的规则；用户 deny 仍优先并显示自己的理由。
// ============================================================================

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/host/services/infra/logger', () => {
  const fake = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { createLogger: vi.fn(() => fake), logger: fake, default: fake };
});

vi.mock('../../../src/host/tools/shell/dynamicDescription', () => ({
  generateBashDescription: async () => null,
}));

import { getToolCache } from '../../../src/host/services/infra/toolCache';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import { normalizeToolName } from '../../../src/host/tools/toolNames';
import { evaluateGuardFabricGate } from '../../../src/host/tools/guardFabricGate';
import type { PermissionRequestData } from '../../../src/host/tools/types';
import { HostReasonCode } from '../../../src/shared/contract/permission';
import { getPolicyEngine, resetPolicyEngine } from '../../../src/host/permissions/policyEngine';
import type { ExecutionTopology } from '../../../src/host/permissions';
import { getPermissionModeManager, resetPermissionModeManager } from '../../../src/host/permissions/modes';

const gate = (
  tool: string,
  params: Record<string, unknown>,
  permissionLevel: 'read' | 'write' | 'execute',
  topology: ExecutionTopology = 'main',
) =>
  evaluateGuardFabricGate({
    executionToolName: tool,
    policyToolName: normalizeToolName(tool),
    params,
    topology,
    sessionId: 'builtin-deny',
    permissionLevel,
  });

describe('guardFabricGate 内置不可覆盖 deny', () => {
  beforeAll(() => {
    getProtocolRegistry(); // 用户规则校验依赖已注册的工具名
  });
  beforeEach(() => resetPolicyEngine());
  afterEach(() => resetPolicyEngine());

  it.each<ExecutionTopology>(['main', 'async_agent'])('%s：Write /usr/bin/x 被 block-root-write 硬拒并给出路', (topology) => {
    const r = gate('Write', { file_path: '/usr/bin/x' }, 'write', topology);
    expect(r.deny).toBeDefined();
    expect(r.deny!.error).toContain('Blocked by built-in safety rule (Block root filesystem writes)');
    expect(r.deny!.error).toContain('workspace');
    // N-FIX-PERM-DENY-ENGLISH-COPY：硬拒带结构化 hostReason；error 原文（模型可见）不变。
    expect(r.deny!.hostReason?.code).toBe(HostReasonCode.PermissionDeniedSafetyRule);
    expect(r.deny!.hostReason?.metadata).toMatchObject({ toolName: 'Write' });
    expect(r.deny!.trace?.steps[0]).toMatchObject({ layer: 'policy_enforcer', rule: 'block-root-write', result: 'deny' });
  });

  it.each(['~/.ssh/id_rsa', '/Users/a/.ssh/id_ed25519', '/home/a/.ssh/id_ecdsa'])('Read %s 被 block-ssh-keys 硬拒', (p) => {
    const r = gate('Read', { file_path: p }, 'read');
    expect(r.deny?.trace?.steps[0]).toMatchObject({ rule: 'block-ssh-keys', result: 'deny' });
  });

  it('filePath 参数形态同样命中', () => {
    expect(gate('Write', { filePath: '/etc/hosts' }, 'write').deny).toBeDefined();
  });

  it('公钥 id_rsa.pub 不被误杀（不走硬拒）', () => {
    expect(gate('Read', { file_path: '/Users/a/.ssh/id_rsa.pub' }, 'read').deny).toBeUndefined();
    expect(gate('Read', { file_path: '/Users/a/.ssh/id_ed25519.pub' }, 'read').deny).toBeUndefined();
  });

  it('Bash rm -rf / 硬拒；rm -rf ./build 与 rm -rf /tmp/x 不拒', () => {
    expect(gate('Bash', { command: 'rm -rf /' }, 'execute').deny?.trace?.steps[0]).toMatchObject({ rule: 'block-rm-rf-root' });
    expect(gate('Bash', { command: 'rm -rf ./build' }, 'execute').deny).toBeUndefined();
    expect(gate('Bash', { command: 'rm -rf /tmp/x' }, 'execute').deny).toBeUndefined();
  });

  it('工作区路径与只读 /usr 不误拒', () => {
    expect(gate('Write', { file_path: '/Users/a/proj/x.ts' }, 'write').deny).toBeUndefined();
    expect(gate('Read', { file_path: '/usr/bin/x' }, 'read').deny).toBeUndefined();
  });

  it('已知限制（不修）：/usr/local 同样被拒；相对路径与 /private/etc 不匹配', () => {
    expect(gate('Write', { file_path: '/usr/local/bin/x' }, 'write').deny).toBeDefined();
    expect(gate('Write', { file_path: 'usr/bin/x' }, 'write').deny).toBeUndefined();
    expect(gate('Write', { file_path: '/private/etc/hosts' }, 'write').deny).toBeUndefined();
  });

  it('用户 deny 同时命中时优先，显示自己的理由', () => {
    getPolicyEngine().loadUserRules({ deny: ['Write'] }, 'user-ui');
    const r = gate('Write', { file_path: '/usr/bin/x' }, 'write');
    expect(r.deny?.error).toContain('Blocked by your permission deny rule');
    expect(r.deny?.reason).toMatch(/^user-config:/);
    // N-FIX-PERM-DENY-ENGLISH-COPY：用户规则硬拒的 hostReason 码独立于内置规则码。
    expect(r.deny?.hostReason?.code).toBe(HostReasonCode.PermissionDeniedUserRule);
  });
});

describe('ToolExecutor 内置硬拒（端到端，零审批卡）', () => {
  let workspace: string;
  let permissionRequests: PermissionRequestData[];

  beforeAll(() => {
    getProtocolRegistry();
  });
  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'builtin-deny-'));
    permissionRequests = [];
    resetPolicyEngine();
    resetPermissionModeManager();
    getToolCache().clear();
  });
  afterEach(async () => {
    resetPolicyEngine();
    resetPermissionModeManager();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  const executor = () => {
    const e = new ToolExecutor({
      workingDirectory: workspace,
      requestPermission: async (request) => {
        permissionRequests.push(request);
        return true;
      },
    });
    e.setAuditEnabled(false);
    return e;
  };

  it('Write /usr/bin/x：硬拒，审批回调零调用', async () => {
    const result = await executor().execute('Write', { file_path: '/usr/bin/neo-probe', content: 'x' }, { sessionId: 'bd-w' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Blocked by built-in safety rule');
    // N-FIX-PERM-DENY-ENGLISH-COPY：硬拒结果透传 hostReason（renderer 登记表据此出人话）。
    expect(result.metadata?.hostReason).toMatchObject({ code: HostReasonCode.PermissionDeniedSafetyRule });
    expect(permissionRequests).toHaveLength(0);
  });

  it('Read ~/.ssh/id_rsa：硬拒，审批回调零调用', async () => {
    const result = await executor().execute('Read', { file_path: path.join(os.homedir(), '.ssh', 'id_rsa') }, { sessionId: 'bd-r' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Blocked by built-in safety rule');
    expect(permissionRequests).toHaveLength(0);
  });

  it.each(['acceptEdits', 'bypassPermissions', 'dontAsk'] as const)('%s 档同样硬拒', async (mode) => {
    const modes = getPermissionModeManager();
    const previous = modes.getEffectiveMode();
    const ok = modes.setMode(mode, true);
    try {
      if (!ok) return;
      const result = await executor().execute('Write', { file_path: '/etc/neo-probe', content: 'x' }, { sessionId: `bd-${mode}` });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Blocked by built-in safety rule');
      expect(permissionRequests).toHaveLength(0);
    } finally {
      modes.setMode(previous, true);
    }
  });
});
