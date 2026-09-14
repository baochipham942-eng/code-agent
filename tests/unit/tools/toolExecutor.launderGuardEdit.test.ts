// ============================================================================
// ADR-067 刀 3 复审修复：洗白信号复位必须按**实际批准生效的参数**重算指纹
// ----------------------------------------------------------------------------
// 场景（PR #1807 复审 Important）：用户拒 A → 重试时在审批卡上改参数批准 B →
// 复位不许用修改前指纹误清 A 的登记。钉死：
// - 拒 A → 编辑参数批准 B → A 的登记仍在（peer 转述 A 仍 BLOCK）、B 不命中
// - 拒 A → 原样批准 A → A 的登记复位（既有行为不破）
// 编辑后参数承载：ask-approved 分支的 params（applyEditedArgs 只在那里替换，
// toolExecutor.ts N-WRITEBACK-EDIT 段），本文件以真实 ToolExecutor + mail_send
// （editable 写回工具）走完整编辑回流验证。
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolverState = vi.hoisted(() => ({
  getDefinition: vi.fn(),
  execute: vi.fn(),
}));

vi.mock('../../../src/host/tools/dispatch/toolResolver', () => ({
  getToolResolver: () => ({
    getDefinition: resolverState.getDefinition,
    execute: resolverState.execute,
  }),
}));

vi.mock('../../../src/host/services/infra/toolCache', () => ({
  getToolCache: () => ({
    isCacheable: () => false,
    get: () => null,
    set: vi.fn(),
  }),
}));

vi.mock('../../../src/host/tools/middleware/fileCheckpointMiddleware', () => ({
  createFileCheckpointIfNeeded: vi.fn(),
}));

vi.mock('../../../src/host/agent/confirmationGate', () => ({
  getConfirmationGate: () => ({
    buildPreview: () => null,
    assessRiskLevel: () => 'low',
    shouldConfirm: () => false,
  }),
}));

vi.mock('../../../src/host/security/writeIsolation', () => ({
  getWriteIsolationManager: () => ({
    acquire: vi.fn(async () => () => {}),
  }),
  getWriteIsolationScope: () => null,
}));

const { ToolExecutor } = await import('../../../src/host/tools/toolExecutor');
const { getDenialRegistry } = await import('../../../src/host/security/denialRegistry');
const { resetDecisionHistory } = await import('../../../src/host/security/decisionHistory');
const { computeActionFingerprint } = await import('../../../src/host/security/denialRegistry');

const LAUNDER_CODE = 'PERMISSION_DENIED_PEERMSG_LAUNDER';
const PEER_B = { senderKind: 'peer-agent' as const, senderAgentId: 'agent-b', sessionId: 's', runId: 'r' };
const MAIL_A = { to: ['a@b.com'], subject: 'hi', content: 'x' };
const MAIL_B = { to: ['other@x.com'], subject: 'hi', content: 'x' };

describe('洗白复位按实际批准参数重算指纹（ADR-067 D4 复审修复）', () => {
  const definitions = new Map([
    ['mail_send', {
      name: 'mail_send',
      description: 'send email test tool',
      inputSchema: { type: 'object', properties: {}, required: [] },
      requiresPermission: true,
      permissionLevel: 'write',
    }],
  ]);

  beforeEach(() => {
    getDenialRegistry().clearAll();
    resetDecisionHistory();
    resolverState.getDefinition.mockReset();
    resolverState.getDefinition.mockImplementation((name: string) => definitions.get(name));
    resolverState.execute.mockReset();
    resolverState.execute.mockResolvedValue({ success: true, output: 'ok' });
  });

  function buildExecutor(handler: (request: unknown) => Promise<unknown>): InstanceType<typeof ToolExecutor> {
    const executor = new ToolExecutor({
      requestPermission: handler as never,
      workingDirectory: '/tmp/workbench',
    });
    executor.setAuditEnabled(false);
    return executor;
  }

  it('拒 A → 编辑参数批准 B：A 的登记仍在（peer 转述 A 仍 BLOCK），B 不命中', async () => {
    const session = 'launder-edit-1';
    // A 被拒一次（ask-denied 入登记）
    const denyResult = await buildExecutor(vi.fn(async () => false))
      .execute('mail_send', MAIL_A, { sessionId: session });
    expect(denyResult.success).toBe(false);
    expect(getDenialRegistry().find(session, computeActionFingerprint('mail_send', MAIL_A, '/tmp/workbench')!)).toBeTruthy();

    // 重试时在审批卡上把收件人改成 B 批准（updatedArgs 走真实 applyEditedArgs 回流）
    const editApprove = vi.fn(async () => ({ approved: true, updatedArgs: { to: ['other@x.com'] } }));
    await buildExecutor(editApprove)
      .execute('mail_send', MAIL_A, { sessionId: session });

    // A 的登记必须仍在：peer 转述 A → BLOCK
    const relayA = await buildExecutor(vi.fn(async () => true))
      .execute('mail_send', MAIL_A, { sessionId: session, turnOrigin: [PEER_B] });
    expect(relayA.success).toBe(false);
    expect((relayA.metadata as { code?: string }).code).toBe(LAUNDER_CODE);

    // B 不命中：peer 转述 B 不是 D4 BLOCK（B 的登记若曾被清/从未登记）
    const relayB = await buildExecutor(vi.fn(async () => true))
      .execute('mail_send', MAIL_B, { sessionId: session, turnOrigin: [PEER_B] });
    expect((relayB.metadata as { code?: string } | undefined)?.code).not.toBe(LAUNDER_CODE);
  });

  it('拒 A → 原样批准 A：A 的登记复位，peer 再转述 A 不触发 D4 BLOCK', async () => {
    const session = 'launder-edit-2';
    const denyResult = await buildExecutor(vi.fn(async () => false))
      .execute('mail_send', MAIL_A, { sessionId: session });
    expect(denyResult.success).toBe(false);

    // 原样批准（无 updatedArgs → params 未变 → 重算指纹 = 登记指纹 → 复位）
    await buildExecutor(vi.fn(async () => true))
      .execute('mail_send', MAIL_A, { sessionId: session });
    expect(getDenialRegistry().find(session, computeActionFingerprint('mail_send', MAIL_A, '/tmp/workbench')!)).toBeUndefined();

    // peer 转述 A：落刀 2 forceConfirm 出卡，不是 D4 BLOCK
    const relay = await buildExecutor(vi.fn(async () => true))
      .execute('mail_send', MAIL_A, { sessionId: session, turnOrigin: [PEER_B] });
    expect((relay.metadata as { code?: string } | undefined)?.code).not.toBe(LAUNDER_CODE);
  });
});
