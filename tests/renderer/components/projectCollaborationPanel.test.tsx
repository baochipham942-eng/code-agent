// @vitest-environment jsdom
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { NeoWorkCardDetail, NeoWorkCardStatus } from '../../../src/shared/contract/tag';
import { ProjectCollaborationPanel } from '../../../src/renderer/components/features/projectCollaboration/ProjectCollaborationPanel';
import { ProjectCollaborationPage } from '../../../src/renderer/components/features/projectCollaboration/ProjectCollaborationPage';
import {
  buildProjectCollaborationGroups,
  NEO_PROJECT_COLLABORATION_FIXTURE,
} from '../../../src/renderer/components/features/projectCollaboration/projectCollaborationData';
import {
  isNeoWorkCardAwaitingRuntimeTerminal,
  resetNeoWorkCardLiveUpdatesForTests,
  useNeoWorkCardStore,
} from '../../../src/renderer/stores/neoWorkCardStore';
import { useToastStore } from '../../../src/renderer/hooks/useToast';
import { useAuthStore } from '../../../src/renderer/stores/authStore';

function makeDetail(input: {
  id: string;
  projectId?: string;
  title?: string;
  status?: NeoWorkCardStatus;
  summary?: string;
  requesterUserId?: string;
  memoryCandidate?: boolean;
  deltaDecisions?: string[];
  deltaRisks?: string[];
  deltaChangedFiles?: string[];
  fullHistory?: boolean;
}): NeoWorkCardDetail {
  const projectId = input.projectId ?? 'project-live';
  const status = input.status ?? 'needs_review';
  const requesterUserId = input.requesterUserId ?? 'user-1';
  const revision = {
    id: `rev-${input.id}`,
    workCardId: input.id,
    revisionNumber: 1,
    intent: 'implement' as const,
    taskSummary: input.summary ?? '从真实 project list/detail 加载',
    readScope: {
      mode: 'current_project' as const,
      projectId,
      conversationIds: ['session-live'],
      messageIds: [],
      artifactIds: [],
      fileGlobs: ['src/renderer/**'],
      memoryEntryIds: [],
      notes: ['read note'],
    },
    writeScope: {
      mode: 'current_project' as const,
      projectId,
      allowedPaths: ['src/renderer/**'],
      canCreateFiles: true,
      canModifyFiles: true,
      canWriteProjectMemory: Boolean(input.memoryCandidate),
      externalDestinations: [],
      notes: ['write note'],
    },
    modelIntent: { mode: 'inherit_current' as const },
    memoryPlan: { mode: 'none' as const, entries: [], notes: [] },
    expectedOutputs: [{ kind: 'patch' as const, title: 'Renderer closure' }],
    risks: [],
    assumptions: [],
    createdByUserId: requesterUserId,
    createdAt: 100,
  };
  const delta = status === 'in_result_review' || input.deltaDecisions?.length || input.deltaRisks?.length || input.deltaChangedFiles?.length ? {
    id: `delta-${input.id}`,
    workCardId: input.id,
    runId: `run-${input.id}`,
    completed: status === 'in_result_review' ? ['完成真实结果'] : [],
    changedFiles: input.deltaChangedFiles ?? [],
    decisions: input.deltaDecisions ?? [],
    openQuestions: input.fullHistory ? ['还需要确认发布入口'] : [],
    risks: input.deltaRisks ?? [],
    memoryCandidates: input.fullHistory ? ['完整记录记忆候选'] : [],
    nextStep: input.fullHistory ? '继续复核' : undefined,
    createdAt: 250,
  } : null;
  const memoryCandidate = {
    id: `mem-${input.id}`,
    workCardId: input.id,
    projectId,
    revisionId: `rev-${input.id}`,
    deltaId: null,
    kind: 'workflow_convention' as const,
    text: '真实记忆候选',
    source: 'explicit_memory_plan' as const,
    status: 'pending' as const,
    createdAt: 260,
    decidedByUserId: null,
    decidedAt: null,
    rejectionReason: null,
    writtenAt: null,
    writtenMemoryKey: null,
  };
  return {
    workCard: {
      id: input.id,
      projectId,
      sourceConversationId: 'session-live',
      sourceTurnId: `turn-${input.id}`,
      requesterUserId,
      title: input.title ?? `真实项目卡 ${input.id}`,
      status,
      currentRevisionId: `rev-${input.id}`,
      approvedRevisionId: ['approved', 'queued', 'working', 'waiting_for_user', 'in_result_review', 'completed'].includes(status)
        ? `rev-${input.id}`
        : null,
      createdAt: 100,
      updatedAt: 200,
    },
    currentRevision: revision,
    approvedRevision: null,
    revisions: input.fullHistory ? [
      revision,
      {
        ...revision,
        id: `rev-${input.id}-2`,
        revisionNumber: 2,
        taskSummary: '第二版完整任务定义',
        createdAt: 150,
      },
    ] : [],
    approvals: input.fullHistory ? [{
      id: `approval-${input.id}`,
      workCardId: input.id,
      revisionId: revision.id,
      projectId,
      requesterUserId,
      approvedByUserId: 'reviewer-1',
      decision: 'approved',
      approvedReadScope: revision.readScope,
      approvedWriteScope: revision.writeScope,
      approvedModelIntent: revision.modelIntent,
      approvedMemoryPlan: revision.memoryPlan,
      feedback: '可以执行',
      expiresAt: null,
      createdAt: 180,
      revokedAt: null,
      supersededByRevisionId: null,
    }] : [],
    deltas: delta ? [delta] : [],
    resultReviews: input.fullHistory ? [{
      id: `review-${input.id}`,
      workCardId: input.id,
      projectId,
      actorUserId: 'reviewer-1',
      decision: 'accepted',
      feedback: '结果确认',
      openQuestions: [],
      createdAt: 300,
    }] : [],
    memoryCandidates: input.memoryCandidate || input.fullHistory ? [memoryCandidate] : [],
  };
}

function recordFromDetail(detail: NeoWorkCardDetail) {
  return {
    card: detail.workCard,
    revision: detail.currentRevision!,
    delta: detail.deltas.at(-1),
    memoryCandidates: detail.memoryCandidates,
  };
}

function resetNeoStore(): void {
  useNeoWorkCardStore.setState({
    detailsById: {},
    loadingConversationIds: {},
    loadingProjectIds: {},
    pendingStatusById: {},
    lastErrorByProjectId: {},
  });
  useToastStore.setState({ toasts: [] });
  useAuthStore.setState({ user: null, isAuthenticated: false });
  delete (window as any).domainAPI;
  delete (window as any).codeAgentDomainAPI;
  delete (window as any).codeAgentAPI;
  delete (window as any).electronAPI;
  resetNeoWorkCardLiveUpdatesForTests();
}

afterEach(() => {
  cleanup();
  resetNeoStore();
});

describe('ProjectCollaborationPanel', () => {
  it('only polls work cards while runtime terminal state is still pending', () => {
    expect(isNeoWorkCardAwaitingRuntimeTerminal('approved')).toBe(true);
    expect(isNeoWorkCardAwaitingRuntimeTerminal('queued')).toBe(true);
    expect(isNeoWorkCardAwaitingRuntimeTerminal('working')).toBe(true);
    expect(isNeoWorkCardAwaitingRuntimeTerminal('waiting_for_user')).toBe(true);
    expect(isNeoWorkCardAwaitingRuntimeTerminal('in_result_review')).toBe(false);
    expect(isNeoWorkCardAwaitingRuntimeTerminal('failed')).toBe(false);
    expect(isNeoWorkCardAwaitingRuntimeTerminal('completed')).toBe(false);
    expect(isNeoWorkCardAwaitingRuntimeTerminal('cancelled')).toBe(false);
    expect(isNeoWorkCardAwaitingRuntimeTerminal('archived')).toBe(false);
  });

  it('groups fixture work cards into the P0 collaboration sections', () => {
    const groups = buildProjectCollaborationGroups(NEO_PROJECT_COLLABORATION_FIXTURE);

    expect(groups.overview).toMatchObject({
      total: 5,
      review: 1,
      running: 1,
      resultReview: 1,
      completed: 1,
      attention: 0,
      closed: 0,
      queue: 1,
      decisions: 2,
      memoryCandidates: 2,
      contextAudits: 1,
    });
    expect(groups.review.map((record) => record.card.id)).toEqual(['wc-review']);
    expect(groups.running.map((record) => record.card.id)).toEqual(['wc-running']);
    expect(groups.resultReview.map((record) => record.card.id)).toEqual(['wc-result-review']);
    expect(groups.completed.map((record) => record.card.id)).toEqual(['wc-completed']);
    expect(groups.queue.map((record) => record.card.id)).toEqual(['wc-queued']);
  });

  it('keeps failed cards out of completed and exposes them as needing attention', () => {
    const failed = recordFromDetail(makeDetail({
      id: 'card-failed',
      status: 'failed',
      title: 'Provider 401',
      deltaRisks: ['401 Unauthorized'],
      deltaDecisions: ['Context audit: pack=ctx_failed strategy=work_card_thread messages=1 artifacts=0 files=0 memory=0 excluded=0 tokens=260/6000 sources=messages'],
    }));
    const completed = recordFromDetail(makeDetail({ id: 'card-done', status: 'completed' }));
    const groups = buildProjectCollaborationGroups([failed, completed]);

    expect(groups.overview.completed).toBe(1);
    expect(groups.overview.attention).toBe(1);
    expect(groups.completed.map((record) => record.card.id)).toEqual(['card-done']);
    expect(groups.attention.map((record) => record.card.id)).toEqual(['card-failed']);
    expect(groups.contextAudits[0]).toMatchObject({
      id: 'ctx_failed',
      selectedEvidenceCount: 1,
      estimatedTokens: 260,
      sourceTypes: ['messages'],
    });
  });

  it('renders overview, work card groups, decisions, memory candidates, context audit, and queue', () => {
    const html = renderToStaticMarkup(
      <ProjectCollaborationPanel records={NEO_PROJECT_COLLABORATION_FIXTURE} />,
    );

    expect(html).toContain('Neo 项目合作');
    expect(html).toContain('Overview');
    expect(html).toContain('待审');
    expect(html).toContain('运行中');
    expect(html).toContain('结果待看');
    expect(html).toContain('已完成');
    expect(html).toContain('需要处理');
    expect(html).toContain('已关闭');
    expect(html).toContain('决策');
    expect(html).toContain('记忆候选');
    expect(html).toContain('上下文审计');
    expect(html).toContain('队列');
    expect(html).toContain('@neo 生成项目合作面板 UI skeleton');
    expect(html).toContain('Tag 管理入口独立于 TaskPanel');
    expect(html).toContain('P0 只做项目合作面板 skeleton 和入口');
    expect(html).toContain('待确认');
    expect(html).toContain('已写入');
    expect(html).toContain('批准记忆');
    expect(html).toContain('接受');
    expect(html).toContain('退回');
    expect(html).toContain('work_card_thread');
    expect(html).toContain('发起人 user-local');
  });

  it('wraps the collaboration panel as an independent page', () => {
    const html = renderToStaticMarkup(
      <ProjectCollaborationPage projectId="project-live" onClose={vi.fn()} />,
    );

    expect(html).toContain('Neo 协同');
    expect(html).toContain('Project work cards · project-live');
    expect(html).toContain('project-collaboration-page');
  });

  it('shows a web mode project binding empty state when no project is selected', () => {
    const html = renderToStaticMarkup(<ProjectCollaborationPanel />);

    expect(html).toContain('浏览器模式不能打开系统目录选择器');
    expect(html).toContain('当前工作区');
  });

  it('does not render cancel for failed terminal cards and keeps archive available', () => {
    const failed = recordFromDetail(makeDetail({
      id: 'card-failed',
      status: 'failed',
      title: 'Provider 401',
      deltaRisks: ['401 Unauthorized'],
    }));

    render(<ProjectCollaborationPanel records={[failed]} />);

    expect(screen.getByTestId('project-collab-section-attention')).toBeTruthy();
    expect(screen.queryByTestId('project-collab-cancel-card-failed')).toBeNull();
    expect(screen.getByTestId('project-collab-archive-card-failed')).toBeTruthy();
  });

  it('loads real project scoped list/detail data without falling back to fixture cards', async () => {
    const detail = makeDetail({ id: 'card-live', title: '真实项目卡', status: 'needs_review' });
    const invoke = vi.fn(async (_domain: string, action: string) => {
      if (action === 'listByProject') {
        return { success: true, data: [detail.workCard] };
      }
      if (action === 'get') {
        return { success: true, data: detail };
      }
      return { success: false, error: { message: `unexpected ${action}` } };
    });
    (window as any).domainAPI = { invoke };

    render(<ProjectCollaborationPanel projectId="project-live" />);

    await waitFor(() => expect(screen.getByText('真实项目卡')).toBeTruthy());
    expect(screen.queryByText('@neo 生成项目合作面板 UI skeleton')).toBeNull();
    expect(invoke).toHaveBeenCalledWith('domain:tag', 'listByProject', {
      projectId: 'project-live',
      includeArchived: true,
    });
    expect(invoke).toHaveBeenCalledWith('domain:tag', 'get', { workCardId: 'card-live' });
  });

  it('selects a work card and renders the full task record detail', async () => {
    const detail = makeDetail({
      id: 'card-full',
      title: '完整任务记录卡',
      status: 'needs_review',
      fullHistory: true,
      memoryCandidate: true,
      deltaChangedFiles: ['src/renderer/full-detail.tsx'],
    });
    const other = makeDetail({ id: 'card-other', title: '另一个卡片', status: 'working' });
    const details = new Map([
      [detail.workCard.id, detail],
      [other.workCard.id, other],
    ]);
    const invoke = vi.fn(async (_domain: string, action: string, payload: any) => {
      if (action === 'listByProject') return { success: true, data: [detail.workCard, other.workCard] };
      if (action === 'get') return { success: true, data: details.get(payload.workCardId) };
      return { success: false, error: { message: `unexpected ${action}` } };
    });
    (window as any).domainAPI = { invoke };

    render(<ProjectCollaborationPanel projectId="project-live" />);

    await waitFor(() => expect(screen.getByTestId('project-collab-detail-pane').textContent).toContain('完整任务记录卡'));
    expect(screen.getByTestId('project-collab-detail-current-task').textContent).toContain('Renderer closure');
    expect(screen.getByTestId('project-collab-detail-timeline').textContent).toContain('revision #2');
    expect(screen.getByTestId('project-collab-detail-timeline').textContent).toContain('approved by reviewer-1');
    expect(screen.getByTestId('project-collab-detail-timeline').textContent).toContain('src/renderer/full-detail.tsx');
    expect(screen.getByTestId('project-collab-detail-records').textContent).toContain('结果确认');
    expect(screen.getByTestId('project-collab-detail-memory').textContent).toContain('真实记忆候选');
    expect(screen.getByTestId('project-collab-detail-scope').textContent).toContain('src/renderer/**');

    fireEvent.click(screen.getByTestId('project-collab-row-card-other'));
    await waitFor(() => expect(screen.getByTestId('project-collab-detail-pane').textContent).toContain('另一个卡片'));
  });

  it('filters work cards by status, requester, mine, and changed file search', async () => {
    useAuthStore.setState({
      user: { id: 'user-me', email: 'me@example.com' } as any,
      isAuthenticated: true,
    });
    const mine = makeDetail({
      id: 'card-mine',
      title: '我的运行卡',
      requesterUserId: 'user-me',
      status: 'working',
      deltaChangedFiles: ['src/renderer/mine-search-target.tsx'],
    });
    const other = makeDetail({
      id: 'card-other-filter',
      title: '别人完成卡',
      requesterUserId: 'user-2',
      status: 'completed',
      deltaChangedFiles: ['src/renderer/other-search-target.tsx'],
    });
    const details = new Map([
      [mine.workCard.id, mine],
      [other.workCard.id, other],
    ]);
    const invoke = vi.fn(async (_domain: string, action: string, payload: any) => {
      if (action === 'listByProject') return { success: true, data: [mine.workCard, other.workCard] };
      if (action === 'get') return { success: true, data: details.get(payload.workCardId) };
      return { success: false, error: { message: `unexpected ${action}` } };
    });
    (window as any).domainAPI = { invoke };

    render(<ProjectCollaborationPanel projectId="project-live" />);

    await waitFor(() => expect(screen.getByTestId('project-collab-row-card-mine')).toBeTruthy());
    expect(screen.getByTestId('project-collab-row-card-other-filter')).toBeTruthy();

    fireEvent.click(screen.getByTestId('project-collab-status-filter-completed'));
    await waitFor(() => expect(screen.queryByTestId('project-collab-row-card-mine')).toBeNull());
    expect(screen.getByTestId('project-collab-row-card-other-filter')).toBeTruthy();

    fireEvent.click(screen.getByTestId('project-collab-status-filter-all'));
    fireEvent.change(screen.getByTestId('project-collab-requester-filter'), { target: { value: 'user-2' } });
    await waitFor(() => expect(screen.queryByTestId('project-collab-row-card-mine')).toBeNull());
    expect(screen.getByTestId('project-collab-row-card-other-filter')).toBeTruthy();

    fireEvent.change(screen.getByTestId('project-collab-requester-filter'), { target: { value: 'all' } });
    fireEvent.click(screen.getByTestId('project-collab-mine-filter'));
    await waitFor(() => expect(screen.getByTestId('project-collab-row-card-mine')).toBeTruthy());
    expect(screen.queryByTestId('project-collab-row-card-other-filter')).toBeNull();

    fireEvent.click(screen.getByTestId('project-collab-mine-filter'));
    fireEvent.change(screen.getByTestId('project-collab-search'), {
      target: { value: 'other-search-target.tsx' },
    });
    await waitFor(() => expect(screen.queryByTestId('project-collab-row-card-mine')).toBeNull());
    expect(screen.getByTestId('project-collab-row-card-other-filter')).toBeTruthy();
  });

  it('applies tag event live updates without reloading the project list', async () => {
    const detail = makeDetail({
      id: 'card-live-refresh',
      title: '实时结果卡',
      status: 'in_result_review',
      deltaDecisions: [
        'Context audit: pack=ctx_live strategy=work_card_thread messages=1 artifacts=0 files=0 memory=0 excluded=0 tokens=260/6000 sources=messages',
      ],
    });
    const invoke = vi.fn(async (_domain: string, action: string) => {
      if (action === 'listByProject') return { success: true, data: [] };
      return { success: false, error: { message: `unexpected ${action}` } };
    });
    let tagEventHandler: ((event: unknown) => void) | null = null;
    const on = vi.fn((channel: string, callback: (event: unknown) => void) => {
      if (channel === 'tag:event') tagEventHandler = callback;
      return vi.fn();
    });
    (window as any).domainAPI = { invoke };
    (window as any).codeAgentAPI = { on };

    render(<ProjectCollaborationPanel projectId="project-live" />);

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('domain:tag', 'listByProject', {
      projectId: 'project-live',
      includeArchived: true,
    }));
    expect(tagEventHandler).toBeTruthy();

    act(() => {
      tagEventHandler?.({
        type: 'work_card_updated',
        reason: 'runtime_result_review',
        workCardId: detail.workCard.id,
        projectId: detail.workCard.projectId,
        sourceConversationId: detail.workCard.sourceConversationId,
        status: detail.workCard.status,
        detail,
        occurredAt: Date.now(),
      });
    });

    await waitFor(() => expect(screen.getAllByText('实时结果卡').length).toBeGreaterThan(0));
    expect(screen.getByTestId('project-collab-section-result-review')).toBeTruthy();
    expect(screen.getByTestId('project-collab-section-context-audit').textContent).toContain('ctx_live');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('edits draft cards and exposes action failures through toast state', async () => {
    const detail = makeDetail({ id: 'card-draft', status: 'draft', summary: '旧任务理解' });
    const updatedDetail = makeDetail({ id: 'card-draft', status: 'draft', summary: '新的任务理解' });
    const invoke = vi.fn(async (_domain: string, action: string, payload: any) => {
      if (action === 'listByProject') return { success: true, data: [detail.workCard] };
      if (action === 'get') return { success: true, data: payload.workCardId === 'card-draft' ? updatedDetail : detail };
      if (action === 'updateDraftRevision') return { success: true, data: { workCard: updatedDetail.workCard, revision: updatedDetail.currentRevision } };
      if (action === 'rejectRevision') return { success: false, error: { message: 'review failed loudly' } };
      return { success: true, data: detail };
    });
    (window as any).domainAPI = { invoke };

    render(<ProjectCollaborationPanel projectId="project-live" />);

    fireEvent.click(await screen.findByTestId('project-collab-edit-draft-card-draft'));
    fireEvent.change(screen.getByTestId('project-collab-summary-input-card-draft'), {
      target: { value: '新的任务理解' },
    });
    fireEvent.click(screen.getByTestId('project-collab-save-draft-card-draft'));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      'domain:tag',
      'updateDraftRevision',
      expect.objectContaining({
        workCardId: 'card-draft',
        revision: expect.objectContaining({ taskSummary: '新的任务理解' }),
      }),
    ));

    fireEvent.click(screen.getByTestId('project-collab-reject-card-draft'));

    await waitFor(() => {
      expect(useToastStore.getState().toasts.some((toast) => toast.message === 'review failed loudly')).toBe(true);
    });
  });

  it('can accept/reject memory candidates through visible controls', async () => {
    const approveMemory = vi.fn();
    const rejectMemory = vi.fn();
    const record = NEO_PROJECT_COLLABORATION_FIXTURE.find((item) => item.card.id === 'wc-running')!;

    render(
      <ProjectCollaborationPanel
        records={[record]}
        onApproveMemory={approveMemory}
        onRejectMemory={rejectMemory}
      />,
    );

    fireEvent.click(screen.getByTestId('project-collab-approve-memory-mem-running-1'));
    fireEvent.click(screen.getByTestId('project-collab-reject-memory-mem-running-1'));

    expect(approveMemory).toHaveBeenCalledWith('mem-running-1');
    expect(rejectMemory).toHaveBeenCalledWith('mem-running-1');
  });
});
