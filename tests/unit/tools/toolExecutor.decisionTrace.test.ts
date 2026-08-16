import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolverState = vi.hoisted(() => ({
  getDefinition: vi.fn(),
  execute: vi.fn(),
}));

/** N-PERMTRACE 变异开关：让分类器抛错 / 还原，两个方向都在本文件内跑。 */
const classifierState = vi.hoisted(() => ({ shouldThrow: false }));

vi.mock('../../../src/host/tools/toolPermissionClassification', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../../src/host/tools/toolPermissionClassification')
  >();
  return {
    ...actual,
    resolveToolPermissionClassification: async (
      input: Parameters<typeof actual.resolveToolPermissionClassification>[0],
    ) => {
      if (classifierState.shouldThrow) throw new Error('classifier boom');
      return actual.resolveToolPermissionClassification(input);
    },
  };
});

vi.mock('../../../src/host/tools/dispatch/toolResolver', () => ({
  getToolResolver: () => ({
    getDefinition: resolverState.getDefinition,
    execute: resolverState.execute,
  }),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { resetDecisionHistory, getDecisionHistory } from '../../../src/host/security/decisionHistory';
import { createCLIPermissionHandler } from '../../../src/cli/permissionPolicy';
import { ToolExecutor, type ToolExecutorConfig } from '../../../src/host/tools/toolExecutor';
import { CLASSIFIER_ERROR_TRACE_RULE } from '../../../src/host/tools/toolPermissionClassification';
import { getToolLedgerSink, setToolLedgerSink } from '../../../src/host/tools/toolLedgerSink';

describe('ToolExecutor decision trace history', () => {
  beforeEach(() => {
    resetDecisionHistory();
    resolverState.getDefinition.mockReset();
    resolverState.execute.mockReset();
    resolverState.execute.mockResolvedValue({ success: true, result: 'ok' });
  });

  it('records a reviewable decision trace for classifier auto-approval', async () => {
    resolverState.getDefinition.mockReturnValue({
      name: 'Read',
      description: 'read test tool',
      inputSchema: { type: 'object', properties: {}, required: [] },
      requiresPermission: true,
      permissionLevel: 'read',
    });
    const requestPermission = vi.fn().mockResolvedValue(true);
    const executor = new ToolExecutor({
      requestPermission,
      workingDirectory: '/tmp/workbench',
    });

    const result = await executor.execute('Read', { file_path: 'README.md' }, { sessionId: 's1' });

    expect(result.success).toBe(true);
    expect(requestPermission).not.toHaveBeenCalled();
    const [entry] = getDecisionHistory().getRecent(1);
    expect(entry).toMatchObject({
      toolName: 'Read',
      outcome: 'auto-approve',
    });
    expect(entry.decisionTrace).toMatchObject({
      toolName: 'Read',
      finalOutcome: 'allow',
      steps: [
        expect.objectContaining({
          layer: 'permission_classifier',
          rule: 'auto-approve',
          result: 'allow',
        }),
      ],
    });
  });

  it('records a deny trace for classifier-denied dangerous commands', async () => {
    resolverState.getDefinition.mockReturnValue({
      name: 'bash',
      description: 'shell test tool',
      inputSchema: { type: 'object', properties: {}, required: [] },
      requiresPermission: true,
      permissionLevel: 'execute',
    });
    const executor = new ToolExecutor({
      requestPermission: vi.fn().mockResolvedValue(true),
      workingDirectory: '/tmp/workbench',
    });

    const result = await executor.execute('bash', { command: 'rm -rf *' }, { sessionId: 's1' });

    expect(result.success).toBe(false);
    const [entry] = getDecisionHistory().getRecent(1);
    expect(entry).toMatchObject({
      toolName: 'bash',
      outcome: 'monitor-blocked',
    });
    expect(entry.decisionTrace?.finalOutcome).toBe('deny');
    expect(entry.decisionTrace?.steps[0]?.layer).toBe('guard_fabric');
  });

  it('denies an external Write ask in the headless handler without executing it', async () => {
    resolverState.getDefinition.mockReturnValue({
      name: 'Write',
      description: 'write test tool',
      inputSchema: { type: 'object', properties: {}, required: [] },
      requiresPermission: true,
      permissionLevel: 'write',
    });
    const executor = new ToolExecutor({
      requestPermission: createCLIPermissionHandler({ warn: vi.fn() }),
      workingDirectory: '/tmp/workbench',
    });

    const result = await executor.execute('Write', {
      file_path: '/Users/linchen/boundary_probe.txt',
      content: 'probe',
    }, { sessionId: 's1' });

    expect(result.success).toBe(false);
    expect(resolverState.execute).not.toHaveBeenCalled();
    const [entry] = getDecisionHistory().getRecent(1);
    expect(entry).toMatchObject({ toolName: 'Write', outcome: 'ask-denied' });
    expect(entry.decisionTrace?.finalOutcome).toBe('deny');
  });
});

// ============================================================================
// N-PERMTRACE：ask-denied 落库必须带真 trace，reason 必须说实话
// ----------------------------------------------------------------------------
// 修之前：`recordDecision(..., 'ask-denied', 'user', ..., undefined, ...)` —— trace 整条
// 丢弃 + reason 写死 'user'。而 `/api/run` 的审批处理器（createCLIPermissionHandler）
// 恒自动拒绝，用户根本没见过审批卡 ⇒ 账本把机器拒的记成人拒的，事后审计分不出来。
// ============================================================================

const WRITE_TOOL_DEF = {
  name: 'Write',
  description: 'write test tool',
  inputSchema: { type: 'object', properties: {}, required: [] },
  requiresPermission: true,
  permissionLevel: 'write' as const,
};
const EXTERNAL_WRITE_PARAMS = {
  file_path: '/Users/linchen/boundary_probe.txt',
  content: 'probe',
};

describe('N-PERMTRACE 审批拒绝路径可观测性', () => {
  beforeEach(() => {
    resetDecisionHistory();
    classifierState.shouldThrow = false;
    resolverState.getDefinition.mockReset();
    resolverState.execute.mockReset();
    resolverState.execute.mockResolvedValue({ success: true, result: 'ok' });
    resolverState.getDefinition.mockReturnValue(WRITE_TOOL_DEF);
  });

  async function denyOnce(requestPermission: ToolExecutorConfig['requestPermission']) {
    const executor = new ToolExecutor({ requestPermission, workingDirectory: '/tmp/workbench' });
    const result = await executor.execute('Write', EXTERNAL_WRITE_PARAMS, { sessionId: 's1' });
    const [entry] = getDecisionHistory().getRecent(1);
    return { result, entry };
  }

  it('无审批 UI 的运行环境自动拒 → reason 记 no-approval-ui，不是 user', async () => {
    const { result, entry } = await denyOnce(createCLIPermissionHandler({ warn: vi.fn() }));

    expect(result.success).toBe(false);
    expect(entry).toMatchObject({ outcome: 'ask-denied', reason: 'no-approval-ui' });
    expect(entry.reason).not.toBe('user');
    // 给模型的文案也要说实话 + 给出路，不能再说「用户拒绝了」
    expect(result.error).not.toContain('Permission denied by user');
    expect(result.error).toContain('没有审批界面');
    expect(result.error).toContain('bypassPermissions');
  });

  it('对照组：真人拒绝（裸 boolean false）仍记 user，文案不变', async () => {
    const { result, entry } = await denyOnce(vi.fn().mockResolvedValue(false));

    expect(entry).toMatchObject({ outcome: 'ask-denied', reason: 'user' });
    expect(result.error).toBe('Permission denied by user');
  });

  it('处理器自报 timeout → reason 记 timeout（不按调用方名字枚举）', async () => {
    const { entry } = await denyOnce(
      vi.fn().mockResolvedValue({ approved: false, denialSource: 'timeout' }),
    );

    expect(entry).toMatchObject({ outcome: 'ask-denied', reason: 'timeout' });
  });

  it('trace 不再被丢弃：ask-denied 带完整决策链（含 ask_denied 那一步）', async () => {
    const { entry } = await denyOnce(vi.fn().mockResolvedValue(false));

    expect(entry.decisionTrace?.finalOutcome).toBe('deny');
    // 修之前这里恒为 1（recordDecision 传 undefined ⇒ 合成一条 plan_approval/ask-denied/user）
    expect(entry.decisionTrace!.steps.length).toBeGreaterThan(1);
    expect(entry.decisionTrace!.steps).toContainEqual(
      expect.objectContaining({ layer: 'plan_approval', rule: 'ask_denied', result: 'deny' }),
    );
  });

  it('变异：分类器抛错 → 账本写「分类器失败」而不是 user，且仍然拒（不 fail-open）', async () => {
    classifierState.shouldThrow = true;
    const { result, entry } = await denyOnce(vi.fn().mockResolvedValue(false));

    expect(entry.outcome).toBe('ask-denied');
    expect(entry.reason).toContain(CLASSIFIER_ERROR_TRACE_RULE);
    expect(entry.reason).not.toBe('user');
    expect(entry.decisionTrace!.steps).toContainEqual(
      expect.objectContaining({
        layer: 'permission_classifier',
        rule: CLASSIFIER_ERROR_TRACE_RULE,
        reason: expect.stringContaining('classifier boom'),
      }),
    );
    // 负例：借这次改动 fail-open 是绝对不允许的——拒还是要拒，工具一次都不许跑。
    expect(result.success).toBe(false);
    expect(resolverState.execute).not.toHaveBeenCalled();
  });

  it('变异还原：分类器不抛错 → 同一条路径变回 user', async () => {
    classifierState.shouldThrow = false;
    const { entry } = await denyOnce(vi.fn().mockResolvedValue(false));

    expect(entry.reason).toBe('user');
    expect(entry.reason).not.toContain(CLASSIFIER_ERROR_TRACE_RULE);
  });

  it('分类器抛错时放行路径也不受影响：批准仍是批准（负例守 fail-closed 的另一侧）', async () => {
    classifierState.shouldThrow = true;
    const executor = new ToolExecutor({
      requestPermission: vi.fn().mockResolvedValue(true),
      workingDirectory: '/tmp/workbench',
    });

    const result = await executor.execute('Write', EXTERNAL_WRITE_PARAMS, { sessionId: 's1' });

    expect(result.success).toBe(true);
    expect(getDecisionHistory().getRecent(1)[0]).toMatchObject({ outcome: 'ask-approved' });
  });
});

describe('N-L10S3 机器批准来源可审计', () => {
  beforeEach(() => {
    resetDecisionHistory();
    classifierState.shouldThrow = false;
    resolverState.getDefinition.mockReset();
    resolverState.execute.mockReset();
    resolverState.execute.mockResolvedValue({ success: true, result: 'ok' });
    resolverState.getDefinition.mockReturnValue(WRITE_TOOL_DEF);
  });

  it('dev 自动批准与真人批准能按账本 reason 直接过滤', async () => {
    const previousSink = getToolLedgerSink();
    const appendPermissionDecision = vi.fn();
    setToolLedgerSink({
      appendPermissionDecision,
      appendToolExecutionBegin: vi.fn(),
      appendToolExecutionComplete: vi.fn(),
    });
    try {
      const machineExecutor = new ToolExecutor({
        requestPermission: vi.fn().mockResolvedValue({
          approved: true,
          approvalSource: 'dev-auto-approve',
        }),
        workingDirectory: '/tmp/workbench',
      });
      await expect(machineExecutor.execute('Write', EXTERNAL_WRITE_PARAMS, { sessionId: 'machine' }))
        .resolves.toMatchObject({ success: true });

      const userExecutor = new ToolExecutor({
        requestPermission: vi.fn().mockResolvedValue(true),
        workingDirectory: '/tmp/workbench',
      });
      await expect(userExecutor.execute('Write', EXTERNAL_WRITE_PARAMS, { sessionId: 'user' }))
        .resolves.toMatchObject({ success: true });

      const decisions = getDecisionHistory().getRecent(2);
      expect(decisions.filter((entry) => entry.reason === 'dev-auto-approve')).toHaveLength(1);
      expect(decisions.filter((entry) => entry.reason === 'user')).toHaveLength(1);
      expect(appendPermissionDecision.mock.calls.map(([entry]) => entry.reason))
        .toEqual(expect.arrayContaining(['dev-auto-approve', 'user']));
    } finally {
      setToolLedgerSink(previousSink);
    }
  });
});
