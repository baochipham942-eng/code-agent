// ============================================================================
// ADR-067 刀 2：turn 起源进权限判定（origin-aware permission）行为级测试
// ----------------------------------------------------------------------------
// 真实 ToolExecutor + mock classifier/execPolicy（toolExecutor.safeCommandPermission
// 同款 harness）。覆盖门：
// - peer 起源写/执行必出确认卡，审批负载带 triggeredByAgentMessage.senderAgentId
// - classifier/preApproved/bypassPermissions/standing-grant 自动放行全部让路
// - user/orchestrator 起源不升档；只读工具不升档；无 turnOrigin 不升档
// - 混合起源取最不可信者
// - 无人值守 peer 起源写/执行 fail-closed（PERMISSION_DENIED_PEER_ORIGIN_UNATTENDED）
// ============================================================================

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/host/tools/shell/dynamicDescription', () => ({
  generateBashDescription: async () => null,
}));

const execPolicyState = vi.hoisted(() => ({
  match: (_cmd: string): 'allow' | 'prompt' | 'forbidden' | null => null,
}));

const classifierState = vi.hoisted(() => ({
  autoApprove: false,
}));

vi.mock('../../../src/host/security', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/host/security')>();
  return {
    ...original,
    getExecPolicyStore: () => ({
      match: (cmd: string) => execPolicyState.match(cmd),
      learnFromApproval: () => false,
    }),
  };
});

vi.mock('../../../src/host/tools/permissionClassifier', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/host/tools/permissionClassifier')>();
  return {
    ...original,
    classifyPermission: vi.fn(async (
      ...args: Parameters<typeof original.classifyPermission>
    ) => {
      if (classifierState.autoApprove) {
        return {
          decision: 'approve' as const,
          reason: 'test auto-approve',
          confidence: 1,
          cached: false,
        };
      }
      return original.classifyPermission(...args);
    }),
  };
});

import { getToolCache } from '../../../src/host/services/infra/toolCache';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import type { PermissionRequestData } from '../../../src/host/tools/types';
import type { AgentMessageOrigin } from '../../../src/host/agent/messageOrigin';
import { getPermissionModeManager } from '../../../src/host/permissions/modes';
import { resetPolicyEnforcer } from '../../../src/host/security/policyEnforcer';
import { getPolicyEngine, resetPolicyEngine } from '../../../src/host/permissions/policyEngine';
import { resolveCanonicalRunPath } from '../../../src/host/runtime/runContext';

const PEER: AgentMessageOrigin = { senderKind: 'peer-agent', senderAgentId: 'agent-b', sessionId: 's', runId: 'r' };
const USER: AgentMessageOrigin = { senderKind: 'user', sessionId: 's', runId: 'r' };
const ORCHESTRATOR: AgentMessageOrigin = { senderKind: 'orchestrator', sessionId: 's', runId: 'r' };

describe('ToolExecutor turn 起源权限闸（ADR-067 D3）', () => {
  let workspace: string;
  let permissionRequests: PermissionRequestData[];
  let previousSafetyMode: string | undefined;
  let sid = 0;

  beforeAll(() => {
    getProtocolRegistry();
  });

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'peer-origin-perm-'));
    await fs.writeFile(path.join(workspace, 'bar'), 'foo\n', 'utf8');
    permissionRequests = [];
    previousSafetyMode = process.env.CODE_AGENT_SHELL_SAFETY_MODE;
    process.env.CODE_AGENT_SHELL_SAFETY_MODE = 'strict';
    getToolCache().clear();
    resetPolicyEnforcer();
    resetPolicyEngine();
    getPolicyEngine();
  });

  afterEach(async () => {
    execPolicyState.match = () => null;
    classifierState.autoApprove = false;
    if (previousSafetyMode === undefined) delete process.env.CODE_AGENT_SHELL_SAFETY_MODE;
    else process.env.CODE_AGENT_SHELL_SAFETY_MODE = previousSafetyMode;
    await fs.rm(workspace, { recursive: true, force: true });
  });

  function buildExecutor(options: {
    approve?: boolean;
    permissionModeOverride?: 'bypassPermissions' | 'acceptEdits';
    preApprovedTools?: Set<string>;
  } = {}): ToolExecutor {
    const executor = new ToolExecutor({
      workingDirectory: workspace,
      ...(options.permissionModeOverride ? { permissionModeOverride: options.permissionModeOverride } : {}),
      requestPermission: async (request) => {
        permissionRequests.push(request);
        return options.approve === true;
      },
    });
    executor.setAuditEnabled(false);
    (executor as unknown as { __preApproved?: Set<string> }).__preApproved = options.preApprovedTools;
    return executor;
  }

  function sessionId(label: string): string {
    sid += 1;
    return `peer-origin-${label}-${sid}`;
  }

  it('peer 起源 bash 必出确认卡：forceConfirm + 卡面带 senderAgentId + turnOrigin 透传', async () => {
    const executor = buildExecutor();
    const result = await executor.execute(
      'Bash',
      { command: 'find . -name dummy.tmp -delete' },
      { sessionId: sessionId('card'), turnOrigin: [PEER] },
    );

    expect(permissionRequests).toHaveLength(1);
    const request = permissionRequests[0];
    expect(request.forceConfirm).toBe(true);
    expect(request.details.triggeredByAgentMessage).toEqual({ senderAgentId: 'agent-b' });
    expect(request.turnOrigin).toEqual([PEER]);
    expect(result.success).toBe(false);
  });

  it('classifier 判 approve 也压不住：peer 起源仍出卡（降档在自动放行之后）', async () => {
    classifierState.autoApprove = true;
    const executor = buildExecutor();
    await executor.execute(
      'Bash',
      { command: 'git status' },
      { sessionId: sessionId('classifier-approve'), turnOrigin: [PEER] },
    );
    expect(permissionRequests).toHaveLength(1);
    expect(permissionRequests[0].forceConfirm).toBe(true);
  });

  it('Skill 预授权让路：preApprovedTools 含 Bash 仍出卡', async () => {
    const executor = buildExecutor();
    await executor.execute(
      'Bash',
      { command: 'git status' },
      {
        sessionId: sessionId('preapproved'),
        turnOrigin: [PEER],
        preApprovedTools: new Set(['Bash']),
      },
    );
    expect(permissionRequests).toHaveLength(1);
    expect(permissionRequests[0].forceConfirm).toBe(true);
  });

  it('bypassPermissions 不豁免：peer 起源仍出卡', async () => {
    const executor = buildExecutor({ permissionModeOverride: 'bypassPermissions' });
    await executor.execute(
      'Bash',
      { command: 'find . -name x -delete' },
      { sessionId: sessionId('bypass'), turnOrigin: [PEER] },
    );
    expect(permissionRequests).toHaveLength(1);
    expect(permissionRequests[0].forceConfirm).toBe(true);
  });

  it('user 起源行为不变：classifier approve 直通无卡', async () => {
    classifierState.autoApprove = true;
    const executor = buildExecutor();
    const result = await executor.execute(
      'Bash',
      { command: 'grep foo bar' },
      { sessionId: sessionId('user'), turnOrigin: [USER] },
    );
    expect(permissionRequests).toHaveLength(0);
    expect(result.success).toBe(true);
  });

  it('orchestrator 起源不升档：classifier approve 直通无卡', async () => {
    classifierState.autoApprove = true;
    const executor = buildExecutor();
    await executor.execute(
      'Bash',
      { command: 'git status' },
      { sessionId: sessionId('orchestrator'), turnOrigin: [ORCHESTRATOR] },
    );
    expect(permissionRequests).toHaveLength(0);
  });

  it('无 turnOrigin（旧调用方）不升档：classifier approve 直通无卡', async () => {
    classifierState.autoApprove = true;
    const executor = buildExecutor();
    await executor.execute(
      'Bash',
      { command: 'git status' },
      { sessionId: sessionId('legacy') },
    );
    expect(permissionRequests).toHaveLength(0);
  });

  it('混合起源取最不可信者：[user, peer] 出卡，[user, orchestrator] 不出', async () => {
    classifierState.autoApprove = true;
    const executor = buildExecutor();
    await executor.execute(
      'Bash',
      { command: 'git status' },
      { sessionId: sessionId('mixed-peer'), turnOrigin: [USER, PEER] },
    );
    expect(permissionRequests).toHaveLength(1);

    permissionRequests = [];
    await executor.execute(
      'Bash',
      { command: 'git status' },
      { sessionId: sessionId('mixed-orch'), turnOrigin: [USER, ORCHESTRATOR] },
    );
    expect(permissionRequests).toHaveLength(0);
  });

  it('只读工具不升档：peer 起源 Read 经 classifier approve 直通无卡', async () => {
    classifierState.autoApprove = true;
    const executor = buildExecutor();
    const result = await executor.execute(
      'Read',
      { file_path: path.join(workspace, 'bar') },
      { sessionId: sessionId('readonly'), turnOrigin: [PEER] },
    );
    expect(permissionRequests).toHaveLength(0);
    expect(result.success).toBe(true);
  });

  it('无人值守 fail-closed：peer 起源写/执行被拒（稳定 code），不进审批', async () => {
    const id = sessionId('unattended');
    getPermissionModeManager().markUnattendedSession(id);
    const executor = buildExecutor({ approve: true });
    const result = await executor.execute(
      'Bash',
      { command: 'find . -name x -delete' },
      { sessionId: id, turnOrigin: [PEER] },
    );

    expect(result.success).toBe(false);
    expect(permissionRequests).toHaveLength(0);
    const metadata = result.metadata as { code?: string; hostReason?: { code: string; metadata?: Record<string, unknown> } };
    expect(metadata.code).toBe('PERMISSION_DENIED_PEER_ORIGIN_UNATTENDED');
    expect(metadata.hostReason?.code).toBe('PERMISSION_DENIED_PEER_ORIGIN_UNATTENDED');
    expect(metadata.hostReason?.metadata?.senderAgentId).toBe('agent-b');
  });

  it('无人值守下 user 起源不被本闸拦：审批流照常（无人值守停车是审批岛职责）', async () => {
    const id = sessionId('unattended-user');
    getPermissionModeManager().markUnattendedSession(id);
    const executor = buildExecutor({ approve: true });
    await executor.execute(
      'Bash',
      { command: 'find . -name x -delete' },
      { sessionId: id, turnOrigin: [USER] },
    );
    // 不被 peer 闸拦 = 走到了审批处理器（无人值守的停车/拒绝由处理器侧决定，不是本闸语义）
    expect(permissionRequests).toHaveLength(1);
  });

  it('无人值守下 peer 起源只读工具不被本闸拦', async () => {
    const id = sessionId('unattended-read');
    getPermissionModeManager().markUnattendedSession(id);
    classifierState.autoApprove = true;
    const executor = buildExecutor();
    const result = await executor.execute(
      'Read',
      { file_path: path.join(workspace, 'bar') },
      { sessionId: id, turnOrigin: [PEER] },
    );
    expect(result.success).toBe(true);
  });
});
