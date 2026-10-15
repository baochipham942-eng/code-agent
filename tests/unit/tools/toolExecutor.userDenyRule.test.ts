import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/host/tools/shell/dynamicDescription', () => ({
  generateBashDescription: async () => null,
}));

import { getToolCache } from '../../../src/host/services/infra/toolCache';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import type { PermissionRequestData } from '../../../src/host/tools/types';
import { getPolicyEngine, resetPolicyEngine } from '../../../src/host/permissions/policyEngine';
import type { ExecutionTopology } from '../../../src/host/permissions';
import { getPermissionModeManager } from '../../../src/host/permissions/modes';

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
