import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { NeoWorkCardDetail, NeoWorkCardStatus } from '../../../src/shared/contract/tag';
import {
  getNeoWorkCardStatusActions,
  NeoWorkCardInlineCard,
} from '../../../src/renderer/components/features/chat/NeoWorkCardInlineCard';

function makeDetail(status: NeoWorkCardStatus, deltaDecisions: string[] = []): NeoWorkCardDetail {
  return {
    workCard: {
      id: `card-${status}`,
      projectId: 'project-1',
      sourceConversationId: 'session-1',
      sourceTurnId: 'turn-1',
      requesterUserId: 'user-1',
      title: '实现 Neo 入口',
      status,
      currentRevisionId: 'rev-1',
      approvedRevisionId: status === 'approved' ? 'rev-1' : null,
      createdAt: 100,
      updatedAt: 120,
    },
    currentRevision: {
      id: 'rev-1',
      workCardId: `card-${status}`,
      revisionNumber: 1,
      intent: 'plan',
      taskSummary: '把 @neo 变成 work card draft',
      readScope: {
        mode: 'selected_context',
        projectId: 'project-1',
        conversationIds: ['session-1'],
        messageIds: ['message-1'],
        artifactIds: [],
        fileGlobs: [],
        memoryEntryIds: [],
        notes: [],
      },
      writeScope: {
        mode: 'none',
        projectId: 'project-1',
        allowedPaths: [],
        canCreateFiles: false,
        canModifyFiles: false,
        canWriteProjectMemory: false,
        externalDestinations: [],
        notes: [],
      },
      modelIntent: { mode: 'inherit_current' },
      memoryPlan: { mode: 'none', entries: [], notes: [] },
      expectedOutputs: [],
      risks: [],
      assumptions: [],
      createdByUserId: 'user-1',
      createdAt: 100,
    },
    approvedRevision: null,
    revisions: [],
    approvals: [],
    deltas: status === 'in_result_review' || deltaDecisions.length > 0 ? [{
      id: 'delta-1',
      workCardId: `card-${status}`,
      runId: 'run-1',
      completed: status === 'in_result_review' ? ['完成结果复盘入口'] : [],
      changedFiles: ['src/renderer/components/features/chat/NeoWorkCardInlineCard.tsx'],
      decisions: ['accepted 后才 completed', ...deltaDecisions],
      openQuestions: ['是否写入项目记忆'],
      risks: ['runtime 主线仍未接入'],
      memoryCandidates: ['结果复盘可生成显式记忆候选'],
      createdAt: 130,
    }] : [],
    resultReviews: [],
    memoryCandidates: status === 'in_result_review' ? [{
      id: 'mem-1',
      workCardId: `card-${status}`,
      projectId: 'project-1',
      revisionId: 'rev-1',
      deltaId: 'delta-1',
      kind: 'workflow_convention',
      text: 'accepted 后 work card 才进入 completed',
      source: 'result_review',
      status: 'pending',
      createdAt: 130,
      decidedByUserId: null,
      decidedAt: null,
      rejectionReason: null,
      writtenAt: null,
      writtenMemoryKey: null,
    }] : [],
  };
}

describe('NeoWorkCardInlineCard', () => {
  it('exposes the basic status action matrix', () => {
    expect(getNeoWorkCardStatusActions('draft').map((action) => action.action)).toEqual([
      'approve',
      'reject',
      'cancel',
    ]);
    expect(getNeoWorkCardStatusActions('needs_review').map((action) => action.action)).toEqual([
      'approve',
      'reject',
      'cancel',
    ]);
    expect(getNeoWorkCardStatusActions('approved').map((action) => action.action)).toEqual([
      'cancel',
    ]);
    expect(getNeoWorkCardStatusActions('in_result_review').map((action) => action.action)).toEqual([
      'acceptResult',
      'requestChanges',
      'archive',
    ]);
    expect(getNeoWorkCardStatusActions('failed').map((action) => action.action)).toEqual(['archive']);
    expect(getNeoWorkCardStatusActions('completed').map((action) => action.action)).toEqual(['archive']);
    expect(getNeoWorkCardStatusActions('cancelled').map((action) => action.action)).toEqual(['archive']);
    expect(getNeoWorkCardStatusActions('archived')).toEqual([]);
  });

  it('renders an inline card with status and buttons', () => {
    const html = renderToStaticMarkup(<NeoWorkCardInlineCard detail={makeDetail('needs_review')} />);

    expect(html).toContain('data-testid="neo-work-card"');
    expect(html).toContain('data-density="expanded"');
    expect(html).toContain('data-testid="neo-work-card-summary"');
    expect(html).toContain('data-work-card-status="needs_review"');
    expect(html).toContain('批准');
    expect(html).toContain('退回修改');
    expect(html).toContain('取消');
  });

  it('renders result review summary and pending memory diff controls', () => {
    const html = renderToStaticMarkup(<NeoWorkCardInlineCard detail={makeDetail('in_result_review')} />);

    expect(html).toContain('结果待看');
    expect(html).toContain('data-testid="neo-work-card-delta"');
    expect(html).toContain('完成结果复盘入口');
    expect(html).toContain('是否写入项目记忆');
    expect(html).toContain('记忆差异');
    expect(html).toContain('accepted 后 work card 才进入 completed');
    expect(html).toContain('neo-work-card-approve-memory-mem-1');
    expect(html).toContain('接受结果');
    expect(html).toContain('退回修改');
    expect(html).toContain('归档');
  });

  it('renders context audit summary from runtime deltas', () => {
    const html = renderToStaticMarkup(
      <NeoWorkCardInlineCard
        detail={makeDetail('failed', [
          'Context audit: pack=neoctx_card_rev_100 strategy=work_card_thread messages=2 artifacts=1 files=3 memory=0 excluded=4 tokens=620/6000 sources=messages+artifacts+files',
        ])}
      />,
    );

    expect(html).toContain('data-work-card-status="failed"');
    expect(html).toContain('上下文：neoctx_card_rev_100');
    expect(html).toContain('2 消息 / 1 产物 / 3 文件 / 0 记忆');
    expect(html).toContain('620/6000 tokens');
    expect(html).toContain('归档');
    expect(html).not.toContain('取消');
  });

  it('shows a running indicator so execution is visible (#4b)', () => {
    const html = renderToStaticMarkup(<NeoWorkCardInlineCard detail={makeDetail('working')} />);

    expect(html).toContain('data-testid="neo-work-card-running-spinner"');
    expect(html).toContain('data-testid="neo-work-card-running-indicator"');
    expect(html).toContain('Neo 正在执行');
    expect(html).toContain('data-work-card-active="true"');
  });

  it('anchors the result back to the conversation above when in result review (#5)', () => {
    const html = renderToStaticMarkup(<NeoWorkCardInlineCard detail={makeDetail('in_result_review')} />);

    expect(html).toContain('data-testid="neo-work-card-result-anchor"');
    expect(html).toContain('完整运行结果已生成在上方对话');
    expect(html).toContain('运行结果摘要');
    // 结果待看时不应再显示误导性的运行中 spinner
    expect(html).not.toContain('data-testid="neo-work-card-running-spinner"');
  });
});
