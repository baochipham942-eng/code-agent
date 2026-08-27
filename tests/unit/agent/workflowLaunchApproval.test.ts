import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  WorkflowLaunchApprovalGate,
  buildWorkflowLaunchRequest,
} from '../../../src/host/agent/workflowLaunchApproval';
import type { ScriptPreview } from '../../../src/host/agent/scriptRuntime/scriptPreview';
import {
  hasInteractiveUi as realHasInteractiveUi,
  setBrowserWindowInteractionProbe,
} from '../../../src/host/platform/windowBridge';

const notifyNeedsInputMock = vi.hoisted(() => vi.fn());
vi.mock('../../../src/host/services/infra/notificationService', () => ({
  notificationService: { notifyNeedsInput: notifyNeedsInputMock },
}));

beforeEach(() => notifyNeedsInputMock.mockClear());
afterEach(() => {
  vi.useRealTimers();
  setBrowserWindowInteractionProbe(null);
});

const PREVIEW: ScriptPreview = {
  phases: ['decompose', 'investigate'],
  agentCallSites: 5,
  parallelCallSites: 1,
  pipelineCallSites: 1,
  writeHint: false,
  toolCallNames: [],
};

describe('buildWorkflowLaunchRequest', () => {
  it('把静态预览映射成审批请求 + 4 维度', () => {
    const req = buildWorkflowLaunchRequest({
      id: 'wf-1',
      preview: PREVIEW,
      goal: '调研 X',
      budgetTokens: 50000,
      sessionId: 's1',
      now: 1000,
    });
    expect(req.id).toBe('wf-1');
    expect(req.status).toBe('pending');
    expect(req.goal).toBe('调研 X');
    expect(req.phases).toEqual(['decompose', 'investigate']);
    expect(req.estimatedAgentCalls).toBe(5);
    expect(req.fanoutSites).toBe(2); // parallel + pipeline
    expect(req.writeHint).toBe(false);
    expect(req.budgetTokens).toBe(50000);
    expect(req.requestedAt).toBe(1000);
    // 4 维度都有文案
    expect(req.dimensions.cost).toBeTruthy();
    expect(req.dimensions.network).toBeTruthy();
    expect(req.dimensions.contextLeak).toBeTruthy();
    expect(req.dimensions.background).toBeTruthy();
  });

  it('无 budget 时 cost 维度反映「不限」', () => {
    const req = buildWorkflowLaunchRequest({ id: 'x', preview: PREVIEW, now: 0 });
    expect(req.budgetTokens).toBeUndefined();
    expect(req.dimensions.cost).toMatch(/不限|无上限|no limit/i);
  });

  it('writeHint 时 contextLeak / cost 维度反映写风险', () => {
    const req = buildWorkflowLaunchRequest({ id: 'x', preview: { ...PREVIEW, writeHint: true }, now: 0 });
    expect(req.writeHint).toBe(true);
    expect(req.dimensions.background).toMatch(/写|修改|文件/);
  });
});

function makeGate(over: Partial<ConstructorParameters<typeof WorkflowLaunchApprovalGate>[0]> = {}) {
  const deliver = vi.fn();
  const gate = new WorkflowLaunchApprovalGate({
    approvalTimeoutMs: 50,
    hasInteractiveUi: () => true,
    deliver,
    ...over,
  });
  return { gate, deliver };
}

const REQ = () => buildWorkflowLaunchRequest({ id: 'wf-1', preview: PREVIEW, now: 1 });

describe('WorkflowLaunchApprovalGate', () => {
  it('无 renderer 时直接 auto-approve（headless）', async () => {
    const { gate, deliver } = makeGate({ hasInteractiveUi: () => false });
    const result = await gate.requestApproval({ request: REQ() });
    expect(result.approved).toBe(true);
    expect(result.autoApproved).toBe(true);
    expect(deliver).not.toHaveBeenCalled(); // headless 不推 UI 事件
  });

  it('有 renderer 时 pending，approve 后 resolve approved', async () => {
    const { gate, deliver } = makeGate();
    const p = gate.requestApproval({ request: REQ() });
    // 等一拍让 requestApproval 注册 pending + 推 requested 事件
    await new Promise((r) => setTimeout(r, 5));
    expect(gate.getPendingRequests()).toHaveLength(1);
    const ok = gate.approve('wf-1', '同意');
    expect(ok).toBe(true);
    const result = await p;
    expect(result.approved).toBe(true);
    expect(result.autoApproved).toBe(false);
    expect(result.feedback).toBe('同意');
    // deliver 收到 requested + approved
    const types = deliver.mock.calls.map((c) => c[0].type);
    expect(types).toContain('requested');
    expect(types).toContain('approved');
  });

  it('reject 后 resolve rejected', async () => {
    const { gate } = makeGate();
    const p = gate.requestApproval({ request: REQ() });
    await new Promise((r) => setTimeout(r, 5));
    expect(gate.reject('wf-1', '太贵')).toBe(true);
    const result = await p;
    expect(result.approved).toBe(false);
    expect(result.feedback).toBe('太贵');
  });

  it('超时：writeHint 自动拒绝', async () => {
    const { gate } = makeGate({ hasInteractiveUi: () => false });
    const req = buildWorkflowLaunchRequest({ id: 'wf-w', preview: { ...PREVIEW, writeHint: true }, now: 1 });
    const result = await gate.requestApproval({ request: req });
    expect(result.approved).toBe(false);
    expect(result.autoApproved).toBe(true);
  });

  it('超时：只读自动批准', async () => {
    const { gate } = makeGate({ hasInteractiveUi: () => false });
    const result = await gate.requestApproval({ request: REQ() });
    expect(result.approved).toBe(true);
    expect(result.autoApproved).toBe(true);
  });

  it('有交互 UI 时挂过原超时仍 pending，人工批准继续生效', async () => {
    vi.useFakeTimers();
    setBrowserWindowInteractionProbe(() => true);
    const { gate } = makeGate({ approvalTimeoutMs: 50, hasInteractiveUi: realHasInteractiveUi });
    const promise = gate.requestApproval({ request: REQ() });

    await vi.advanceTimersByTimeAsync(500);
    expect(notifyNeedsInputMock).toHaveBeenCalledTimes(1);
    const marker = Symbol('pending');
    await expect(Promise.race([promise, Promise.resolve(marker)])).resolves.toBe(marker);
    expect(gate.approve('wf-1', '人工批准')).toBe(true);
    await expect(promise).resolves.toMatchObject({ approved: true, autoApproved: false });
  });

  it('无交互 UI 时写工作流按原超时拒绝并返回结构化原因', async () => {
    const { gate } = makeGate({ approvalTimeoutMs: 10, hasInteractiveUi: () => false });
    const request = buildWorkflowLaunchRequest({
      id: 'wf-headless-write',
      preview: { ...PREVIEW, writeHint: true },
      now: 1,
    });
    await expect(gate.requestApproval({ request })).resolves.toMatchObject({
      approved: false,
      permissionDecision: 'deny',
      permissionDecisionReason: expect.stringContaining('无头规则'),
    });
  });

  it('approve 未知 id 返回 false', () => {
    const { gate } = makeGate();
    expect(gate.approve('nope')).toBe(false);
  });

  // ── Codex Round1 MED#1：resolver/timer 生命周期 ──
  it('resolver 在 deliver 之前注册：同步 deliver 里 reject 能被即时兑现（非超时）', async () => {
    const deliver = vi.fn();
    deliver.mockImplementation((e) => {
      if (e.type === 'requested') gate.reject('wf-1', 'sync no');
    });
    const gate = new WorkflowLaunchApprovalGate({ approvalTimeoutMs: 5000, hasInteractiveUi: () => true, deliver });
    const result = await gate.requestApproval({ request: REQ() });
    expect(result.approved).toBe(false);
    expect(result.feedback).toBe('sync no');
    expect(result.autoApproved).toBe(false); // 是人工决议路径，不是超时
  });

  // ── Codex Round2 HIGH#1：approve/reject 必须做会话授权，不能只靠 UI 不显示 ──
  it('approve 的 callerSessionId 与 request.sessionId 不符时拒绝（跨会话审批防护）', async () => {
    const { gate } = makeGate();
    const req = buildWorkflowLaunchRequest({ id: 'wf-A', preview: PREVIEW, sessionId: 'sess-A', now: 1 });
    const p = gate.requestApproval({ request: req });
    await new Promise((r) => setTimeout(r, 5));
    expect(gate.approve('wf-A', 'ok', 'sess-B')).toBe(false); // 别的会话来批 → 拒
    expect(gate.approve('wf-A', 'ok', 'sess-A')).toBe(true); // 本会话批 → 通过
    const result = await p;
    expect(result.approved).toBe(true);
  });

  it('callerSessionId 缺省（headless/legacy）时不阻断（向后兼容）', async () => {
    const { gate } = makeGate();
    const req = buildWorkflowLaunchRequest({ id: 'wf-A', preview: PREVIEW, sessionId: 'sess-A', now: 1 });
    const p = gate.requestApproval({ request: req });
    await new Promise((r) => setTimeout(r, 5));
    expect(gate.approve('wf-A', 'ok')).toBe(true); // 不传 caller → 放行
    await p;
  });

  it('决议后请求从 pending 移除（不泄漏 requests map + timer）', async () => {
    const { gate } = makeGate();
    const p = gate.requestApproval({ request: REQ() });
    await new Promise((r) => setTimeout(r, 5));
    gate.approve('wf-1', 'ok');
    await p;
    expect(gate.getPendingRequests()).toHaveLength(0);
    expect(gate.getRequest('wf-1')).toBeUndefined();
    // 二次 approve 应失败（已结算移除）
    expect(gate.approve('wf-1', 'again')).toBe(false);
  });
});
