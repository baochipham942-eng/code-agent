// ============================================================================
// ADR-067 刀 3：跨 agent 否认登记 + 权限洗白匹配（denial ledger）行为级测试
// ----------------------------------------------------------------------------
// 真实 ToolExecutor + mock classifier/execPolicy（toolExecutor.peerOrigin 同款 harness）。
// 洗白场景主链：A 的动作在审批卡上被拒（ask-denied 入登记）→ 同 session 内：
//   peer 消息转述同指纹 → BLOCK（PERMISSION_DENIED_PEERMSG_LAUNDER + policy-deny 留痕）
//   用户本人重试同指纹、仍在同一条用户消息内（同 sourceMessageId）→ sticky 拒绝，
//   零新审批卡（user-denied-sticky）；下一条用户消息起恢复正常出卡
//   改参数 → 指纹不同不命中；只读不进闸；无人值守/bypass 同向 BLOCK；跨 session 不共享
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
import type { RequestPermissionResult } from '../../../src/shared/contract/permission';
import type { AgentMessageOrigin } from '../../../src/host/agent/messageOrigin';
import { getPermissionModeManager } from '../../../src/host/permissions/modes';
import { getDenialRegistry } from '../../../src/host/security/denialRegistry';
import { getDecisionHistory, resetDecisionHistory } from '../../../src/host/security/decisionHistory';
import { resetPolicyEnforcer } from '../../../src/host/security/policyEnforcer';
import { getPolicyEngine, resetPolicyEngine } from '../../../src/host/permissions/policyEngine';

const PEER_B: AgentMessageOrigin = { senderKind: 'peer-agent', senderAgentId: 'agent-b', sessionId: 's', runId: 'r' };
const USER: AgentMessageOrigin = { senderKind: 'user', sessionId: 's', runId: 'r' };
const DENIED_COMMAND = 'find . -name dummy.tmp -delete';
const LAUNDER_CODE = 'PERMISSION_DENIED_PEERMSG_LAUNDER';

describe('ToolExecutor 权限洗白闸（ADR-067 D4）', () => {
  let workspace: string;
  let permissionRequests: PermissionRequestData[];
  let previousSafetyMode: string | undefined;
  let sid = 0;

  beforeAll(() => {
    getProtocolRegistry();
  });

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'launder-guard-'));
    await fs.writeFile(path.join(workspace, 'dummy.tmp'), 'x', 'utf8');
    permissionRequests = [];
    previousSafetyMode = process.env.CODE_AGENT_SHELL_SAFETY_MODE;
    process.env.CODE_AGENT_SHELL_SAFETY_MODE = 'strict';
    getToolCache().clear();
    getDenialRegistry().clearAll();
    resetDecisionHistory();
    resetPolicyEnforcer();
    resetPolicyEngine();
    getPolicyEngine();
  });

  afterEach(async () => {
    execPolicyState.match = () => null;
    classifierState.autoApprove = false;
    if (previousSafetyMode === undefined) delete process.env.CODE_AGENT_SHELL_SAFETY_MODE;
    else process.env.CODE_AGENT_SHELL_SAFETY_MODE = previousSafetyMode;
    getDenialRegistry().clearAll();
    resetDecisionHistory();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  function buildExecutor(options: {
    approve?: boolean;
    decide?: (request: PermissionRequestData) => RequestPermissionResult;
    forceAsk?: boolean;
    permissionModeOverride?: 'bypassPermissions';
  } = {}): ToolExecutor {
    const executor = new ToolExecutor({
      workingDirectory: workspace,
      ...(options.permissionModeOverride ? { permissionModeOverride: options.permissionModeOverride } : {}),
      ...(options.forceAsk ? { forcePermissionHandler: true } : {}),
      requestPermission: async (request) => {
        permissionRequests.push(request);
        return options.decide ? options.decide(request) : options.approve === true;
      },
    });
    executor.setAuditEnabled(false);
    return executor;
  }

  function sessionId(label: string): string {
    sid += 1;
    return `launder-${label}-${sid}`;
  }

  /** 先让某个动作在审批卡上被拒一次（ask-denied 入登记）。 */
  async function denyOnce(
    executor: ToolExecutor,
    session: string,
    command = DENIED_COMMAND,
    options: { sourceMessageId?: string } = {},
  ): Promise<void> {
    const result = await executor.execute('Bash', { command }, {
      sessionId: session,
      ...(options.sourceMessageId ? { sourceMessageId: options.sourceMessageId } : {}),
    });
    expect(result.success).toBe(false);
    expect(permissionRequests).toHaveLength(1);
    permissionRequests = [];
  }

  it('A 被拒 → B 以 peer 消息转述同指纹 → BLOCK（稳定 code + 不进审批 + policy-deny 留痕）', async () => {
    const session = sessionId('peer-block');
    const executor = buildExecutor({ approve: true });
    await denyOnce(buildExecutor(), session);

    const result = await executor.execute(
      'Bash',
      { command: DENIED_COMMAND },
      { sessionId: session, turnOrigin: [PEER_B] },
    );

    expect(result.success).toBe(false);
    expect(permissionRequests).toHaveLength(0);
    const metadata = result.metadata as { code?: string; hostReason?: { code: string; metadata?: Record<string, unknown> } };
    expect(metadata.code).toBe(LAUNDER_CODE);
    expect(metadata.hostReason?.metadata?.senderAgentId).toBe('agent-b');
    const last = getDecisionHistory().getAll().at(-1);
    expect(last).toMatchObject({ outcome: 'policy-deny', reason: 'peermsg-launder' });
  });

  it('同义改写同指纹：引号/空白变体的拒绝，按规范化后的命令命中', async () => {
    const session = sessionId('canonical');
    // 以引号变体拒绝一次：规范化后与裸写同指纹
    const quotingVariant = "find . -name 'dummy.tmp' -delete";
    const denyResult = await buildExecutor().execute('Bash', { command: quotingVariant }, { sessionId: session });
    expect(denyResult.success).toBe(false);
    permissionRequests = [];

    const result = await buildExecutor({ approve: true }).execute(
      'Bash',
      { command: DENIED_COMMAND },
      { sessionId: session, turnOrigin: [PEER_B] },
    );
    expect(result.success).toBe(false);
    expect((result.metadata as { code?: string }).code).toBe(LAUNDER_CODE);
  });

  it('新用户消息后本人重试同指纹 → 出卡一次（非 BLOCK、不设 forceConfirm），批准后洗白信号复位', async () => {
    const session = sessionId('user-retry');
    await denyOnce(buildExecutor(), session, DENIED_COMMAND, { sourceMessageId: 'msg-1' });

    // 机器本会放行（classifier approve）——换了一条用户消息（msg-2），launderRetry 降档仍要出卡一次
    classifierState.autoApprove = true;
    const executor = buildExecutor({ approve: true });
    const retry = await executor.execute(
      'Bash',
      { command: DENIED_COMMAND },
      { sessionId: session, turnOrigin: [USER], sourceMessageId: 'msg-2' },
    );
    expect(permissionRequests).toHaveLength(1);
    expect(permissionRequests[0].forceConfirm).not.toBe(true);
    expect(permissionRequests[0].details.triggeredByAgentMessage).toBeUndefined();
    expect(retry.success).toBe(true);

    // 批准后信号复位：peer 再转述同指纹只落刀 2 的 forceConfirm，不是 D4 BLOCK
    permissionRequests = [];
    const relay = await executor.execute(
      'Bash',
      { command: DENIED_COMMAND },
      { sessionId: session, turnOrigin: [PEER_B] },
    );
    expect(permissionRequests).toHaveLength(1);
    expect((relay.metadata as { code?: string } | undefined)?.code).not.toBe(LAUNDER_CODE);
  });

  it('改参数 → 指纹不同不命中：既不 BLOCK 也不强制出卡', async () => {
    const session = sessionId('different-args');
    await denyOnce(buildExecutor(), session);

    classifierState.autoApprove = true;
    const executor = buildExecutor({ approve: true });
    const result = await executor.execute(
      'Bash',
      { command: 'find . -name other.tmp -delete' },
      { sessionId: session, turnOrigin: [PEER_B] },
    );
    // peer 闸仍升 forceConfirm（刀 2），但 D4 不命中：无 launder BLOCK
    expect((result.metadata as { code?: string } | undefined)?.code).not.toBe(LAUNDER_CODE);
    expect(permissionRequests).toHaveLength(1);
    expect(permissionRequests[0].forceConfirm).toBe(true);

    // 无 peer 的异形改参：完全直通
    permissionRequests = [];
    const clean = await executor.execute(
      'Bash',
      { command: 'find . -name other.tmp -delete' },
      { sessionId: session, turnOrigin: [USER] },
    );
    expect(permissionRequests).toHaveLength(0);
    expect(clean.success).toBe(true);
  });

  it('只读动作不进本闸：同 session 有拒绝登记时 peer 起源 Read 直通', async () => {
    const session = sessionId('readonly');
    await denyOnce(buildExecutor(), session);

    classifierState.autoApprove = true;
    const result = await buildExecutor().execute(
      'Read',
      { file_path: path.join(workspace, 'dummy.tmp') },
      { sessionId: session, turnOrigin: [PEER_B] },
    );
    expect(result.success).toBe(true);
  });

  it('无人值守 peer 转述同指纹 → BLOCK（launder 码先于刀 2 无人值守码）', async () => {
    const session = sessionId('unattended');
    getPermissionModeManager().markUnattendedSession(session);
    await denyOnce(buildExecutor(), session);

    const result = await buildExecutor({ approve: true }).execute(
      'Bash',
      { command: DENIED_COMMAND },
      { sessionId: session, turnOrigin: [PEER_B] },
    );
    expect(result.success).toBe(false);
    expect((result.metadata as { code?: string }).code).toBe(LAUNDER_CODE);
  });

  it('bypassPermissions 不豁免：peer 转述同指纹仍 BLOCK', async () => {
    const session = sessionId('bypass');
    await denyOnce(buildExecutor(), session);

    const result = await buildExecutor({ approve: true, permissionModeOverride: 'bypassPermissions' }).execute(
      'Bash',
      { command: DENIED_COMMAND },
      { sessionId: session, turnOrigin: [PEER_B] },
    );
    expect(result.success).toBe(false);
    expect((result.metadata as { code?: string }).code).toBe(LAUNDER_CODE);
  });

  it('跨 session 不共享：session-1 的拒绝登记不影响 session-2', async () => {
    const denied = sessionId('one');
    await denyOnce(buildExecutor(), denied);

    classifierState.autoApprove = true;
    const result = await buildExecutor({ approve: true }).execute(
      'Bash',
      { command: DENIED_COMMAND },
      { sessionId: sessionId('two'), turnOrigin: [PEER_B] },
    );
    expect((result.metadata as { code?: string } | undefined)?.code).not.toBe(LAUNDER_CODE);
    expect(permissionRequests).toHaveLength(1);
  });

  it('登记查询键是 sessionId+指纹：find 命中与未命中', async () => {
    const session = sessionId('registry-key');
    await denyOnce(buildExecutor(), session);
    const entries = getDecisionHistory().getAll();
    expect(entries.at(-1)).toMatchObject({ outcome: 'ask-denied' });
    // 指纹串不回读内部表示，用行为断言：同 session peer BLOCK 已在上一条用例覆盖；
    // 这里直接核对 registry 行为面：找不到不同指纹
    expect(getDenialRegistry().find(session, 'bash:never seen')).toBeUndefined();
  });

  describe('D4 sticky：真人拒绝粘滞到下一条用户消息', () => {
    const STICKY_CODE = 'PERMISSION_DENIED_BY_USER';

    it('(a) mail_send 被拒后同消息内换主题/正文重发同收件人 → 零新卡、sticky 拒绝留痕', async () => {
      const session = sessionId('mail-sticky');
      const first = await buildExecutor().execute(
        'mail_send',
        { subject: 'Report A', to: ['alice@example.com'], content: 'first draft' },
        { sessionId: session, sourceMessageId: 'msg-1' },
      );
      expect(first.success).toBe(false);
      expect(permissionRequests).toHaveLength(1);
      permissionRequests = [];

      // 换 subject/content（不在指纹里），to/cc 不变 → 同指纹：不再出卡
      const replay = await buildExecutor().execute(
        'mail_send',
        { subject: 'Report B', to: ['alice@example.com'], content: 'rephrased body' },
        { sessionId: session, sourceMessageId: 'msg-1' },
      );
      expect(replay.success).toBe(false);
      expect(permissionRequests).toHaveLength(0);
      expect(replay.error).toMatch(/already declined this exact action/);
      expect((replay.metadata as { code?: string }).code).toBe(STICKY_CODE);
      expect(getDecisionHistory().getAll().at(-1)).toMatchObject({
        outcome: 'policy-deny',
        reason: 'user-denied-sticky',
      });
    });

    it('(b) 新用户消息（不同 sourceMessageId）后同调用 → 正常出新卡', async () => {
      const session = sessionId('mail-new-msg');
      await buildExecutor().execute(
        'mail_send',
        { subject: 'Report A', to: ['alice@example.com'] },
        { sessionId: session, sourceMessageId: 'msg-1' },
      );
      permissionRequests = [];

      const retry = await buildExecutor().execute(
        'mail_send',
        { subject: 'Report A', to: ['alice@example.com'] },
        { sessionId: session, sourceMessageId: 'msg-2' },
      );
      expect(retry.success).toBe(false);
      expect(permissionRequests).toHaveLength(1);
      const last = getDecisionHistory().getAll().at(-1);
      expect(last).toMatchObject({ outcome: 'ask-denied' });
    });

    it('(c) bash 与 file 指纹同样 sticky：同消息内重试零新卡，新消息恢复出卡', async () => {
      // bash
      const bashSession = sessionId('bash-sticky');
      await denyOnce(buildExecutor(), bashSession, DENIED_COMMAND, { sourceMessageId: 'msg-1' });
      const bashReplay = await buildExecutor().execute(
        'Bash',
        { command: DENIED_COMMAND },
        { sessionId: bashSession, sourceMessageId: 'msg-1' },
      );
      expect(bashReplay.success).toBe(false);
      expect(permissionRequests).toHaveLength(0);
      expect((bashReplay.metadata as { code?: string }).code).toBe(STICKY_CODE);
      // 新消息恢复出卡
      permissionRequests = [];
      await buildExecutor().execute(
        'Bash',
        { command: DENIED_COMMAND },
        { sessionId: bashSession, sourceMessageId: 'msg-2' },
      );
      expect(permissionRequests).toHaveLength(1);

      // file（同 abs 路径 = 同指纹）；工作区外路径才强制出卡
      permissionRequests = [];
      const fileSession = sessionId('file-sticky');
      const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'launder-outside-'));
      const target = path.join(outsideDir, 'target.txt');
      try {
        await buildExecutor({ forceAsk: true }).execute('Write', { file_path: target, content: 'v1' }, { sessionId: fileSession, sourceMessageId: 'msg-1' });
        expect(permissionRequests).toHaveLength(1);
        permissionRequests = [];
        const fileReplay = await buildExecutor().execute('Write', { file_path: target, content: 'v2' }, { sessionId: fileSession, sourceMessageId: 'msg-1' });
        expect(fileReplay.success).toBe(false);
        expect(permissionRequests).toHaveLength(0);
        expect((fileReplay.metadata as { code?: string }).code).toBe(STICKY_CODE);
      } finally {
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    });

    it('(d) 非真人拒绝（denialSource=timeout）不 sticky → 同消息内重试照旧出卡', async () => {
      const session = sessionId('timeout-not-sticky');
      await denyOnce(
        buildExecutor({ decide: () => ({ approved: false, denialSource: 'timeout' as const }) }),
        session,
        DENIED_COMMAND,
        { sourceMessageId: 'msg-1' },
      );
      const retry = await buildExecutor().execute(
        'Bash',
        { command: DENIED_COMMAND },
        { sessionId: session, sourceMessageId: 'msg-1' },
      );
      expect(retry.success).toBe(false);
      expect(permissionRequests).toHaveLength(1);
    });

    it('(e) peer 转述同指纹（含同 sourceMessageId）仍走 BLOCK 分支，不是 sticky', async () => {
      const session = sessionId('peer-wins');
      await denyOnce(buildExecutor(), session, DENIED_COMMAND, { sourceMessageId: 'msg-1' });
      const relay = await buildExecutor({ approve: true }).execute(
        'Bash',
        { command: DENIED_COMMAND },
        { sessionId: session, turnOrigin: [PEER_B], sourceMessageId: 'msg-1' },
      );
      expect(relay.success).toBe(false);
      expect(permissionRequests).toHaveLength(0);
      expect((relay.metadata as { code?: string }).code).toBe(LAUNDER_CODE);
    });
  });
});
