import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type {
  NeoMemoryCandidate,
  NeoWorkCardDelta,
  NeoWorkCardDetail,
  NeoWorkCardStatus,
} from '../../../src/shared/contract/tag';
import {
  getNeoWorkCardStatusActions,
  NeoWorkCardInlineCard,
} from '../../../src/renderer/components/features/chat/NeoWorkCardInlineCard';

interface DetailOverrides {
  completed?: string[];
  changedFiles?: string[];
  openQuestions?: string[];
  risks?: string[];
  nextStep?: string;
  memoryPending?: boolean;
}

function makeDelta(id: string, overrides: DetailOverrides): NeoWorkCardDelta {
  return {
    id,
    workCardId: 'card-1',
    runId: 'run-1',
    completed: overrides.completed ?? [],
    changedFiles: overrides.changedFiles ?? [],
    decisions: [],
    openQuestions: overrides.openQuestions ?? [],
    risks: overrides.risks ?? [],
    memoryCandidates: [],
    nextStep: overrides.nextStep,
    createdAt: 130,
  };
}

function makeMemoryCandidate(): NeoMemoryCandidate {
  return {
    id: 'mem-1',
    workCardId: 'card-1',
    projectId: 'project-1',
    revisionId: 'rev-1',
    deltaId: 'delta-1',
    kind: 'workflow_convention',
    text: '记忆候选文本',
    source: 'result_review',
    status: 'pending',
    createdAt: 130,
    decidedByUserId: null,
    decidedAt: null,
    rejectionReason: null,
    writtenAt: null,
    writtenMemoryKey: null,
  };
}

function makeDetail(status: NeoWorkCardStatus, overrides: DetailOverrides = {}): NeoWorkCardDetail {
  const hasDelta = Boolean(
    overrides.completed?.length
    || overrides.changedFiles?.length
    || overrides.openQuestions?.length
    || overrides.risks?.length
    || overrides.nextStep,
  );
  return {
    workCard: {
      id: 'card-1',
      projectId: 'project-1',
      sourceConversationId: 'session-1',
      sourceTurnId: 'turn-1',
      requesterUserId: 'user-1',
      title: '实现 Neo 入口',
      status,
      currentRevisionId: 'rev-1',
      approvedRevisionId: null,
      createdAt: 100,
      updatedAt: 120,
    },
    currentRevision: {
      id: 'rev-1',
      workCardId: 'card-1',
      revisionNumber: 1,
      intent: 'implement',
      taskSummary: '把 @neo 变成内联清单',
      readScope: {
        mode: 'selected_context', projectId: 'project-1', conversationIds: ['session-1'],
        messageIds: [], artifactIds: [], fileGlobs: [], memoryEntryIds: [], notes: [],
      },
      writeScope: {
        mode: 'none', projectId: 'project-1', allowedPaths: [], canCreateFiles: false,
        canModifyFiles: false, canWriteProjectMemory: false, externalDestinations: [], notes: [],
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
    deltas: hasDelta ? [makeDelta('delta-1', overrides)] : [],
    resultReviews: [],
    memoryCandidates: overrides.memoryPending ? [makeMemoryCandidate()] : [],
  };
}

describe('NeoWorkCardInlineCard (轻量内联清单)', () => {
  it('collapses the status action matrix to cancel (active) / archive (terminal), no approval', () => {
    // 运行相位只保留取消
    for (const status of ['draft', 'needs_review', 'approved', 'queued', 'working', 'waiting_for_user'] as const) {
      expect(getNeoWorkCardStatusActions(status).map((a) => a.action)).toEqual(['cancel']);
    }
    // 终态只保留归档
    for (const status of ['in_result_review', 'completed', 'failed', 'cancelled'] as const) {
      expect(getNeoWorkCardStatusActions(status).map((a) => a.action)).toEqual(['archive']);
    }
    expect(getNeoWorkCardStatusActions('archived')).toEqual([]);
    // 审批语义彻底消失
    const allActions = (['draft', 'needs_review', 'approved', 'in_result_review'] as const)
      .flatMap((status) => getNeoWorkCardStatusActions(status).map((a) => a.action));
    expect(allActions).not.toContain('approve');
    expect(allActions).not.toContain('reject');
    expect(allActions).not.toContain('acceptResult');
    expect(allActions).not.toContain('requestChanges');
  });

  it('renders a slim inline strip, not the old heavy card (no 摘要复述/范围三宫格/审批按钮)', () => {
    const html = renderToStaticMarkup(<NeoWorkCardInlineCard detail={makeDetail('working', { nextStep: '正在编辑文件' })} />);

    expect(html).toContain('data-testid="neo-work-card"');
    expect(html).toContain('data-work-card-status="working"');
    expect(html).toContain('data-work-card-phase="running"');
    // 退役的重卡元素不应再出现
    expect(html).not.toContain('data-testid="neo-work-card-summary"');
    expect(html).not.toContain('读取范围');
    expect(html).not.toContain('写入范围');
    expect(html).not.toContain('data-testid="neo-work-card-context-audit"');
    expect(html).not.toContain('批准');
    expect(html).not.toContain('退回修改');
    expect(html).not.toContain('接受结果');
  });

  it('shows a running progress line (⏳) while Neo is working', () => {
    const html = renderToStaticMarkup(<NeoWorkCardInlineCard detail={makeDetail('working', { nextStep: '正在编辑文件' })} />);

    expect(html).toContain('data-testid="neo-work-card-progress"');
    expect(html).toContain('正在编辑文件');
  });

  it('maps delta.completed into a ✓ checklist when done', () => {
    const html = renderToStaticMarkup(
      <NeoWorkCardInlineCard
        detail={makeDetail('in_result_review', { completed: ['接好内联清单入口', '联调直接开干路径'] })}
      />,
    );

    expect(html).toContain('data-work-card-phase="done"');
    expect(html).toContain('data-testid="neo-work-card-checklist"');
    expect(html).toContain('接好内联清单入口');
    expect(html).toContain('联调直接开干路径');
    // 完成态不再显示运行中 ⏳
    expect(html).not.toContain('data-testid="neo-work-card-progress"');
  });

  it('filters internal runtime lifecycle markers out of the checklist', () => {
    const html = renderToStaticMarkup(
      <NeoWorkCardInlineCard
        detail={makeDetail('in_result_review', {
          completed: ['Queued approved revision rev_abc', 'Local Neo runtime run finished.', '真实完成项'],
        })}
      />,
    );

    expect(html).toContain('真实完成项');
    expect(html).not.toContain('Queued approved revision');
    expect(html).not.toContain('Local Neo runtime run finished');
  });

  it('surfaces open questions when Neo needs input', () => {
    const html = renderToStaticMarkup(
      <NeoWorkCardInlineCard detail={makeDetail('waiting_for_user', { openQuestions: ['要用哪个配色？'] })} />,
    );

    expect(html).toContain('data-work-card-phase="needs_input"');
    expect(html).toContain('data-testid="neo-work-card-needs-input"');
    expect(html).toContain('要用哪个配色？');
  });

  it('surfaces the error when a run fails', () => {
    const html = renderToStaticMarkup(
      <NeoWorkCardInlineCard detail={makeDetail('failed', { risks: ['401 Unauthorized'] })} />,
    );

    expect(html).toContain('data-work-card-phase="failed"');
    expect(html).toContain('data-testid="neo-work-card-error"');
    expect(html).toContain('401 Unauthorized');
  });

  it('shows memory candidates as a light hint (not a form)', () => {
    const html = renderToStaticMarkup(
      <NeoWorkCardInlineCard detail={makeDetail('in_result_review', { completed: ['做完了'], memoryPending: true })} />,
    );

    expect(html).toContain('data-testid="neo-work-card-memory-hint"');
    expect(html).toContain('记忆候选文本');
    expect(html).toContain('neo-work-card-approve-memory-mem-1');
  });
});
