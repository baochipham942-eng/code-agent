// ai-review Nit②：failed 卡返回 null 是把交互交还 DecisionSlot，但 findPendingPlanApproval
// 只取最新一张可决定的卡——会话里出现更新的 pending 审批后，旧 failed 卡既无交互卡也无
// 存证卡，整条从聊天里消失。这里钉住：非当前待决目标的 failed 卡补只读终态存证条。
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TraceNode } from '../../../src/shared/contract/trace';
import type { PlanApprovalRecord } from '../../../src/shared/contract';

// renderToStaticMarkup 下 zustand 的 useSyncExternalStore 会走 server snapshot
// （getInitialState，不是当前 state），mock 掉 i18n / appStore / sessionStore
// （同 toolStepGroup.failCollapse.test.tsx 的做法）；sessionStore 用 hoisted 夹具驱动
// findPendingPlanApproval 的输入。
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      openPreview: vi.fn(),
      openSettingsTab: vi.fn(),
    }),
}));

const h = vi.hoisted(() => ({
  sessionState: { currentSessionId: null as string | null, messages: [] as unknown[] },
}));

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (state: unknown) => unknown) => selector(h.sessionState),
}));

import { ToolStepGroup } from '../../../src/renderer/components/features/chat/ToolStepGroup';
import type { Message } from '../../../src/shared/contract';

const approval: PlanApprovalRecord = {
  status: 'failed',
  originalPlan: '1. Read code\n2. Build card',
  steps: [
    { id: 'step-1', content: 'Read code', originalContent: 'Read code' },
    { id: 'step-2', content: 'Build card', originalContent: 'Build card' },
  ],
  failureReason: 'Session s1 is already running',
  decidedAt: 10,
};

function planNode(id: string, record: PlanApprovalRecord): TraceNode {
  // TraceNode 的 toolCall.result 是字符串、元数据挂 toolCall.metadata（ToolStepGroup
  // 构造 ToolCall 时搬运），与 Message.toolCalls 的形状不同。
  return {
    id: `node-${id}`,
    type: 'tool_call',
    content: '',
    timestamp: 1,
    toolCall: {
      id,
      name: 'exit_plan_mode',
      args: {},
      success: true,
      result: 'ok',
      metadata: { confirmationType: 'plan_approval', plan: record.originalPlan, planApproval: record },
    },
  } as unknown as TraceNode;
}

function messageOf(id: string, record: PlanApprovalRecord): Message {
  return {
    id: `message-${id}`,
    role: 'assistant',
    content: '',
    timestamp: 1,
    toolCalls: [{
      id,
      name: 'exit_plan_mode',
      arguments: {},
      result: {
        toolCallId: id,
        success: true,
        metadata: { confirmationType: 'plan_approval', plan: record.originalPlan, planApproval: record },
      },
    }],
  };
}

describe('ToolStepGroup — failed 计划卡的归属：待决目标交还交互卡，旧卡补存证', () => {
  beforeEach(() => {
    h.sessionState.currentSessionId = 'session-1';
    h.sessionState.messages = [];
  });

  it('failed 卡是当前待决目标（最新可决定卡）→ 交还交互卡，不落存证', () => {
    h.sessionState.messages = [messageOf('tool-failed', approval)];
    const html = renderToStaticMarkup(<ToolStepGroup nodes={[planNode('tool-failed', approval)]} />);
    expect(html).not.toContain('plan-approval-evidence');
    expect(html).not.toContain('计划 · 启动失败');
  });

  it('会话里有更新的 pending 审批 → 旧 failed 卡补只读存证条，不再整条消失', () => {
    const newerPending: PlanApprovalRecord = { ...approval, status: 'pending' };
    delete (newerPending as { failureReason?: string }).failureReason;
    h.sessionState.messages = [messageOf('tool-failed', approval), messageOf('tool-pending-new', newerPending)];
    const html = renderToStaticMarkup(<ToolStepGroup nodes={[planNode('tool-failed', approval)]} />);
    expect(html).toContain('plan-approval-evidence');
    expect(html).toContain('计划 · 启动失败');
  });

  it('approved / starting 等终态与中间态照旧渲染存证条（行为不变）', () => {
    const approved: PlanApprovalRecord = { ...approval, status: 'approved' };
    delete (approved as { failureReason?: string }).failureReason;
    const html = renderToStaticMarkup(<ToolStepGroup nodes={[planNode('tool-approved', approved)]} />);
    expect(html).toContain('plan-approval-evidence');
    expect(html).toContain('已允许');
  });

  it('pending 卡仍交还交互卡（不改既有行为）', () => {
    const pending: PlanApprovalRecord = { ...approval, status: 'pending' };
    delete (pending as { failureReason?: string }).failureReason;
    h.sessionState.messages = [messageOf('tool-pending', pending)];
    const html = renderToStaticMarkup(<ToolStepGroup nodes={[planNode('tool-pending', pending)]} />);
    expect(html).not.toContain('plan-approval-evidence');
  });
});
