// @vitest-environment jsdom
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { NeoWorkCardDelta, NeoWorkCardDetail, NeoWorkCardStatus } from '../../../src/shared/contract/tag';
import { ProjectCollaborationPanel } from '../../../src/renderer/components/features/projectCollaboration/ProjectCollaborationPanel';
import { ProjectCollaborationPage } from '../../../src/renderer/components/features/projectCollaboration/ProjectCollaborationPage';
import { formatRequesterLabel } from '../../../src/renderer/components/features/projectCollaboration/projectCollaborationData';
import { useNeoWorkCardStore } from '../../../src/renderer/stores/neoWorkCardStore';

afterEach(() => {
  cleanup();
  useNeoWorkCardStore.setState({ detailsById: {}, loadingProjectIds: {}, lastErrorByProjectId: {} });
});

function makeDelta(over: Partial<NeoWorkCardDelta> = {}): NeoWorkCardDelta {
  return {
    id: over.id ?? 'delta-1',
    workCardId: over.workCardId ?? 'card-1',
    runId: over.runId ?? 'run-1',
    conversationId: over.conversationId,
    completed: over.completed ?? [],
    changedFiles: over.changedFiles ?? [],
    decisions: over.decisions ?? [],
    openQuestions: over.openQuestions ?? [],
    risks: over.risks ?? [],
    memoryCandidates: over.memoryCandidates ?? [],
    nextStep: over.nextStep,
    createdAt: over.createdAt ?? 130,
  };
}

function makeDetail(input: {
  id: string;
  title?: string;
  status?: NeoWorkCardStatus;
  requesterUserId?: string;
  updatedAt?: number;
  deltas?: NeoWorkCardDelta[];
  memoryPending?: boolean;
}): NeoWorkCardDetail {
  return {
    workCard: {
      id: input.id,
      projectId: 'project-1',
      sourceConversationId: 'session-1',
      sourceTurnId: `turn-${input.id}`,
      requesterUserId: input.requesterUserId ?? 'user-1',
      title: input.title ?? `topic ${input.id}`,
      status: input.status ?? 'working',
      currentRevisionId: `rev-${input.id}`,
      approvedRevisionId: null,
      createdAt: 100,
      updatedAt: input.updatedAt ?? 120,
    },
    currentRevision: {
      id: `rev-${input.id}`,
      workCardId: input.id,
      revisionNumber: 1,
      intent: 'implement',
      taskSummary: `${input.title ?? input.id} 的任务`,
      readScope: {
        mode: 'selected_context', projectId: 'project-1', conversationIds: [], messageIds: [],
        artifactIds: [], fileGlobs: [], memoryEntryIds: [], notes: [],
      },
      writeScope: {
        mode: 'none', projectId: 'project-1', allowedPaths: [], canCreateFiles: false,
        canModifyFiles: false, canWriteProjectMemory: false, externalDestinations: [], notes: [],
      },
      modelIntent: { mode: 'inherit_current' },
      memoryPlan: { mode: 'none', entries: [], notes: [] },
      expectedOutputs: [], risks: [], assumptions: [],
      createdByUserId: input.requesterUserId ?? 'user-1',
      createdAt: 100,
    },
    approvedRevision: null,
    revisions: [],
    approvals: [],
    deltas: input.deltas ?? [],
    resultReviews: [],
    memoryCandidates: input.memoryPending ? [{
      id: 'mem-1', workCardId: input.id, projectId: 'project-1', revisionId: `rev-${input.id}`,
      deltaId: 'delta-1', kind: 'workflow_convention', text: '记忆候选X', source: 'result_review',
      status: 'pending', createdAt: 130, decidedByUserId: null, decidedAt: null,
      rejectionReason: null, writtenAt: null, writtenMemoryKey: null,
    }] : [],
  };
}

describe('formatRequesterLabel', () => {
  it('shows the current user as 我, others as their id', () => {
    expect(formatRequesterLabel('user-1', { id: 'user-1', name: '产品负责人' })).toBe('我 · 产品负责人');
    expect(formatRequesterLabel('user-1', { id: 'user-1' })).toBe('我');
    expect(formatRequesterLabel('user-2', { id: 'user-1', name: '产品负责人' })).toBe('user-2');
    expect(formatRequesterLabel('user-2', null)).toBe('user-2');
  });
});

describe('ProjectCollaborationPanel = @neo topic 目录', () => {
  it('renders a flat topic list with phase + requester, not the old status-grouped dashboard', () => {
    const details = [
      makeDetail({ id: 'a', title: '做落地页', status: 'working', requesterUserId: 'user-1', updatedAt: 200 }),
      makeDetail({ id: 'b', title: '改配色', status: 'in_result_review', requesterUserId: 'user-2', updatedAt: 300 }),
    ];
    const html = renderToStaticMarkup(<ProjectCollaborationPanel projectId="project-1" details={details} />);

    expect(html).toContain('data-testid="neo-topic-directory"');
    expect(html).toContain('data-testid="neo-topic-row-a"');
    expect(html).toContain('data-testid="neo-topic-row-b"');
    expect(html).toContain('做落地页');
    expect(html).toContain('改配色');
    // 每条带发起人
    expect(html).toContain('user-2');
    // 相位标签，非旧 status 分组仪表盘
    expect(html).toContain('运行中');
    expect(html).toContain('已完成');
    // 退役的旧仪表盘区块彻底消失
    expect(html).not.toContain('data-testid="project-collab-section-overview"');
    expect(html).not.toContain('data-testid="project-collab-section-decisions"');
    expect(html).not.toContain('data-testid="project-collab-section-context-audit"');
    expect(html).not.toContain('上下文审计');
    expect(html).not.toContain('批准');
    expect(html).not.toContain('拒绝');
  });

  it('sorts topics by most recent activity (updatedAt desc)', () => {
    const details = [
      makeDetail({ id: 'old', title: '旧的', updatedAt: 100 }),
      makeDetail({ id: 'new', title: '新的', updatedAt: 900 }),
    ];
    const html = renderToStaticMarkup(<ProjectCollaborationPanel projectId="project-1" details={details} />);
    expect(html.indexOf('neo-topic-row-new')).toBeLessThan(html.indexOf('neo-topic-row-old'));
  });

  it('opens a topic detail with the inline checklist + memory candidate when a row is clicked', () => {
    const details = [
      makeDetail({
        id: 'a',
        title: '做落地页',
        status: 'in_result_review',
        deltas: [makeDelta({ completed: ['接好清单入口', 'Local Neo runtime run finished.'], changedFiles: ['src/x.tsx'] })],
        memoryPending: true,
      }),
    ];
    render(<ProjectCollaborationPanel projectId="project-1" details={details} />);
    fireEvent.click(screen.getByTestId('neo-topic-row-a'));

    const detail = screen.getByTestId('neo-topic-detail');
    expect(detail).toBeTruthy();
    expect(screen.getByTestId('neo-topic-detail-checklist').textContent).toContain('接好清单入口');
    // 内部生命周期标记不进清单
    expect(screen.getByTestId('neo-topic-detail-checklist').textContent).not.toContain('Local Neo runtime run finished');
    expect(screen.getByTestId('neo-topic-detail-memory').textContent).toContain('记忆候选X');
    // 无审批/范围/上下文审计区块
    expect(screen.queryByTestId('project-collab-detail-scope')).toBeNull();
    expect(detail.textContent).not.toContain('读取范围');
    expect(detail.textContent).not.toContain('接受结果');
  });

  it('filters topics by phase', () => {
    const details = [
      makeDetail({ id: 'run', title: '在跑的', status: 'working' }),
      makeDetail({ id: 'done', title: '完成的', status: 'completed' }),
    ];
    render(<ProjectCollaborationPanel projectId="project-1" details={details} />);
    fireEvent.click(screen.getByTestId('neo-topic-filter-done'));

    expect(screen.queryByTestId('neo-topic-row-done')).toBeTruthy();
    expect(screen.queryByTestId('neo-topic-row-run')).toBeNull();
  });

  it('shows an empty state when there are no topics', () => {
    const html = renderToStaticMarkup(<ProjectCollaborationPanel projectId="project-1" details={[]} />);
    expect(html).toContain('data-testid="neo-topic-empty"');
  });

  it('does not surface internal runtime bookkeeping as the topic row snippet', () => {
    const details = [
      makeDetail({
        id: 'noisy',
        title: '只有内部记账的 topic',
        deltas: [makeDelta({
          completed: ['Queued approved revision nwcr_1', 'Local Neo runtime run finished.'],
          nextStep: 'Review the result and accept, revise, or archive the work card.',
        })],
      }),
    ];
    const html = renderToStaticMarkup(<ProjectCollaborationPanel projectId="project-1" details={details} />);
    expect(html).not.toContain('Review the result and accept');
    expect(html).not.toContain('Local Neo runtime run finished');
  });

  it('opens the topic detail with multi-round results and a jump-to-conversation entry', () => {
    const details = [makeDetail({ id: 'a', title: '做落地页', status: 'in_result_review' })];
    const sourceMessages = [
      { id: 'u1', role: 'user' as const, content: '@neo 做落地页', timestamp: 1, metadata: { neoTag: { workCardId: 'a' } } },
      { id: 'a1', role: 'assistant' as const, content: '落地页做好了，入口在首页。', timestamp: 2 },
    ];
    const calls: string[] = [];
    render(
      <ProjectCollaborationPanel
        projectId="project-1"
        details={details}
        sourceMessagesByConversation={{ 'session-1': sourceMessages }}
        onOpenConversation={(sessionId) => { calls.push(sessionId); }}
      />,
    );
    fireEvent.click(screen.getByTestId('neo-topic-row-a'));

    const rounds = screen.getByTestId('neo-topic-detail-rounds');
    expect(rounds.textContent).toContain('@neo 做落地页');
    expect(rounds.textContent).toContain('落地页做好了，入口在首页。');

    fireEvent.click(screen.getByTestId('neo-topic-detail-open-conversation'));
    expect(calls).toEqual(['session-1']);
  });

  it('lists every topic from the store when no project is bound (projectId=null → 全局目录, BUG2)', () => {
    // @neo 兜底建的卡挂在各自 projectId（如 proj_unsorted）下；无绑定项目入口必须仍能列出它们
    const a = makeDetail({ id: 'a', title: '无项目 topic A', updatedAt: 300 });
    const b = { ...makeDetail({ id: 'b', title: '另一项目 topic B', updatedAt: 200 }) };
    b.workCard = { ...b.workCard, projectId: 'proj_unsorted' };
    useNeoWorkCardStore.setState({ detailsById: { a, b } });

    render(<ProjectCollaborationPanel projectId={null} />);

    expect(screen.queryByTestId('neo-topic-row-a')).toBeTruthy();
    expect(screen.queryByTestId('neo-topic-row-b')).toBeTruthy();
    // 不再出现"还没有绑定项目"的挡路文案
    expect(screen.queryByText(/还没有绑定项目/)).toBeNull();
  });

  it('page wrapper keeps its testid so the workbench boundary stays intact', () => {
    const html = renderToStaticMarkup(<ProjectCollaborationPage projectId="project-1" onClose={() => {}} />);
    expect(html).toContain('data-testid="project-collaboration-page"');
  });
});

describe('topic 详情跨会话聚合（ADR-035）', () => {
  it('aggregates rounds from every topic conversation with per-round 打开会话', () => {
    const details = [makeDetail({
      id: 'a',
      title: '整理竞品报告',
      status: 'completed',
      deltas: [
        makeDelta({ id: 'd1', workCardId: 'a', runId: 'r1', conversationId: 'session-1' }),
        makeDelta({ id: 'd2', workCardId: 'a', runId: 'r2', conversationId: 'session-2' }),
      ],
    })];
    const calls: string[] = [];
    render(
      <ProjectCollaborationPanel
        projectId="project-1"
        details={details}
        sourceMessagesByConversation={{
          'session-1': [
            { id: 'u1', role: 'user' as const, content: '@neo 整理竞品', timestamp: 1, metadata: { neoTag: { workCardId: 'a' } } },
            { id: 'a1', role: 'assistant' as const, content: '第一轮结论', timestamp: 2 },
          ],
          'session-2': [
            { id: 'u2', role: 'user' as const, content: '补上定价维度', timestamp: 3, metadata: { neoTag: { workCardId: 'a' } } },
            { id: 'a2', role: 'assistant' as const, content: '第二轮结论', timestamp: 4 },
          ],
        }}
        onOpenConversation={(sessionId) => { calls.push(sessionId); }}
      />,
    );
    fireEvent.click(screen.getByTestId('neo-topic-row-a'));

    const rounds = screen.getByTestId('neo-topic-detail-rounds');
    expect(rounds.textContent).toContain('第一轮结论');
    expect(rounds.textContent).toContain('第二轮结论');

    // 轮级打开会话：分别跳该轮真正发生的会话
    fireEvent.click(screen.getByTestId('neo-topic-round-open-0'));
    fireEvent.click(screen.getByTestId('neo-topic-round-open-1'));
    expect(calls).toEqual(['session-1', 'session-2']);
  });

  it('detail follow-up input sends continueAndRun targeting the latest round conversation', async () => {
    const continueAndRun = vi.fn(async () => ({
      detail: makeDetail({ id: 'a' }),
      roundTurnId: 'turn_x',
    }));
    useNeoWorkCardStore.setState({ continueAndRun });

    const details = [makeDetail({
      id: 'a',
      status: 'completed',
      deltas: [makeDelta({ id: 'd2', workCardId: 'a', runId: 'r2', conversationId: 'session-2' })],
    })];
    render(
      <ProjectCollaborationPanel
        projectId="project-1"
        details={details}
        sourceMessagesByConversation={{
          'session-2': [
            { id: 'u2', role: 'user' as const, content: '第二轮', timestamp: 3, metadata: { neoTag: { workCardId: 'a' } } },
          ],
        }}
      />,
    );
    fireEvent.click(screen.getByTestId('neo-topic-row-a'));

    fireEvent.change(screen.getByTestId('neo-topic-detail-followup-input'), { target: { value: '再补渠道对比' } });
    fireEvent.click(screen.getByTestId('neo-topic-detail-followup-send'));

    await vi.waitFor(() => {
      expect(continueAndRun).toHaveBeenCalledWith(expect.objectContaining({
        workCardId: 'a',
        userText: '再补渠道对比',
        conversationId: 'session-2',
      }));
    });
  });
});

describe('topic 详情右侧抽屉（目录-详情分离，非模态）', () => {
  it('opens the detail in a right-side drawer on row click (no drawer before selection)', () => {
    const details = [makeDetail({ id: 'a', title: '抽屉topic' })];
    render(<ProjectCollaborationPanel projectId="project-1" details={details} sourceMessagesByConversation={{}} />);

    expect(screen.queryByTestId('neo-topic-drawer')).toBeNull();
    fireEvent.click(screen.getByTestId('neo-topic-row-a'));

    expect(screen.getByTestId('neo-topic-drawer')).toBeTruthy();
    expect(screen.getByTestId('neo-topic-detail')).toBeTruthy();
  });

  it('closes the drawer via close button and Escape', () => {
    const details = [makeDetail({ id: 'a', title: '抽屉topic' })];
    render(<ProjectCollaborationPanel projectId="project-1" details={details} sourceMessagesByConversation={{}} />);

    // 关闭按钮关
    fireEvent.click(screen.getByTestId('neo-topic-row-a'));
    fireEvent.click(screen.getByTestId('neo-topic-drawer-close'));
    expect(screen.queryByTestId('neo-topic-drawer')).toBeNull();

    // Esc 关
    fireEvent.click(screen.getByTestId('neo-topic-row-a'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('neo-topic-drawer')).toBeNull();
  });

  it('switches drawer content when another row is clicked (list stays interactive, 非模态)', () => {
    const details = [
      makeDetail({ id: 'a', title: '第一个topic' }),
      makeDetail({ id: 'b', title: '第二个topic' }),
    ];
    render(<ProjectCollaborationPanel projectId="project-1" details={details} sourceMessagesByConversation={{}} />);

    fireEvent.click(screen.getByTestId('neo-topic-row-a'));
    expect(screen.getByTestId('neo-topic-detail').textContent).toContain('第一个topic');
    fireEvent.click(screen.getByTestId('neo-topic-row-b'));
    expect(screen.getByTestId('neo-topic-detail').textContent).toContain('第二个topic');
  });
});
