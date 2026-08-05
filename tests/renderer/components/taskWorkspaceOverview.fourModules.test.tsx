// @vitest-environment jsdom
//
// 概览四模块归位（2026-08-04 拍板二/三）：任务（进度线+排队）/ Todo / 上下文 / 产物。
// - Todo 提为一级：无 TODO 不渲染；真读取失败内联 Todo 位置 + 与完成态互斥（C.11）
// - 上下文一级化：每类 ≤5 行，超出收「+N」尾行点开展开
// - 产物：跑中不铺，完成态收拢一排缩略行（图片真缩略图，裂图降级图标），点击进预览
// - 诊断 UI 整体删除：无 AgentTree / 路由证据 / 详情入口

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const appState = vi.hoisted(() => ({
  workingDirectory: '/repo/app',
  openPreview: vi.fn(),
  openContentPreview: vi.fn(),
  openWorkspacePreview: vi.fn(),
}));

const sessionState = vi.hoisted(() => ({
  currentSessionId: 'session-1' as string | null,
  sessions: [{ id: 'session-1', title: '整理竞品定价' }] as Array<{ id: string; title: string }>,
}));

const statusRailState = vi.hoisted(() => ({
  context: { items: [] as Array<never> },
  outputs: { files: [] as Array<never>, count: 0 },
}));

const runWorkbenchState = vi.hoisted(() => ({
  run: {
    status: 'running',
    phase: '执行中',
    identity: { sessionId: 'session-1', turnId: 'turn-1', runId: 'run-1', streamRunId: null, status: 'running' },
    startedAt: 1_700_000_000_000,
  } as Record<string, unknown>,
  tasks: [] as Array<Record<string, unknown>>,
  tools: [] as Array<never>,
  memoryActivities: [] as Array<never>,
  loopDecisions: [] as Array<never>,
  subagents: [] as Array<never>,
  outputs: [] as Array<never>,
}));

const backgroundTaskStore = vi.hoisted(() => ({
  readFailure: null as { message: string; failedAt: number } | null,
  isLoading: false,
  requestStatusReadRetry: vi.fn(),
}));

const taskStore = vi.hoisted(() => ({
  cancelTask: vi.fn(async () => {}),
}));

const memberViewState = vi.hoisted(() => ({
  viewingMemberId: null as string | null,
  setViewingMemberId: vi.fn(),
}));

const memberPills = vi.hoisted(() => ({
  pills: [] as Array<{ key: string; roleId: string; name: string; status: string; isLead: boolean }>,
}));

const artifactOwnershipState = vi.hoisted(() => ({
  current: null as null | {
    turnId: string;
    turnNumber: number;
    tone: 'success';
    artifactOwnership: Array<Record<string, unknown>>;
  },
}));

const previewItemsState = vi.hoisted(() => ({
  items: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ language: 'zh', t: zh }) };
});
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector?: (state: typeof appState) => unknown) => (
    selector ? selector(appState) : appState
  ),
}));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector?: (state: typeof sessionState) => unknown) => (
    selector ? selector(sessionState) : sessionState
  ),
}));
vi.mock('../../../src/renderer/stores/backgroundTaskStore', () => ({
  useBackgroundTaskStore: (selector?: (state: typeof backgroundTaskStore) => unknown) => (
    selector ? selector(backgroundTaskStore) : backgroundTaskStore
  ),
}));
vi.mock('../../../src/renderer/stores/taskStore', () => ({
  useTaskStore: (selector?: (state: typeof taskStore) => unknown) => (
    selector ? selector(taskStore) : taskStore
  ),
}));
vi.mock('../../../src/renderer/stores/memberViewStore', () => ({
  useMemberViewStore: (selector?: (state: typeof memberViewState) => unknown) => (
    selector ? selector(memberViewState) : memberViewState
  ),
}));

vi.mock('../../../src/renderer/components/features/expert/SessionMemberBar', () => ({
  useSessionMembers: () => memberPills.pills,
}));

vi.mock('../../../src/renderer/hooks/useStatusRailModel', () => ({
  useStatusRailModel: () => statusRailState,
}));
vi.mock('../../../src/renderer/hooks/useRunWorkbenchModel', () => ({
  useRunWorkbenchModel: () => runWorkbenchState,
}));
vi.mock('../../../src/renderer/hooks/useCurrentTurnArtifactOwnership', () => ({
  useCurrentTurnArtifactOwnership: () => artifactOwnershipState.current,
}));
vi.mock('../../../src/renderer/hooks/useWorkspacePreviewModel', () => ({
  useWorkspacePreviewModel: () => previewItemsState.items,
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke: vi.fn(), isAvailable: () => false },
  invoke: vi.fn(),
}));

import { TaskWorkspaceOverview } from '../../../src/renderer/components/TaskPanel/TaskWorkspaceOverview';

function setRun(status: string, extra: Record<string, unknown> = {}): void {
  runWorkbenchState.run = {
    status,
    phase: status === 'completed' ? '已完成' : '执行中',
    identity: { sessionId: 'session-1', turnId: 'turn-1', runId: 'run-1', streamRunId: null, status },
    startedAt: 1_700_000_000_000,
    endedAt: status === 'completed' ? 1_700_000_012_000 : undefined,
    ...extra,
  };
}

function sessionTask(steps: Array<{ title: string; status: string }>) {
  return {
    id: 'session:todos',
    scope: 'session',
    title: '整理竞品定价',
    status: 'in_progress',
    steps,
    ownerRunId: null,
    sourceThreadId: 'session-1',
  };
}

afterEach(() => cleanup());

beforeEach(() => {
  setRun('running');
  runWorkbenchState.tasks = [];
  runWorkbenchState.tools = [];
  runWorkbenchState.memoryActivities = [];
  statusRailState.context.items = [];
  statusRailState.outputs.files = [];
  statusRailState.outputs.count = 0;
  backgroundTaskStore.readFailure = null;
  artifactOwnershipState.current = null;
  previewItemsState.items = [];
  appState.openPreview.mockReset();
  appState.openContentPreview.mockReset();
  appState.openWorkspacePreview.mockReset();
  runWorkbenchState.subagents = [];
  memberPills.pills = [];
  memberViewState.setViewingMemberId.mockReset();
});

describe('四模块归位', () => {
  it('模块顺序：任务（进度线）→ Todo → 上下文 → 产物；无诊断入口', () => {
    runWorkbenchState.tasks = [sessionTask([{ title: '收集资料', status: 'in_progress' }])];
    statusRailState.context.items = [
      { id: 'f1', label: 'pricing-notes.md', detail: 'Read', bucket: 'files', source: 'tool', path: '/repo/app/pricing-notes.md' },
    ] as never;
    artifactOwnershipState.current = {
      turnId: 'turn-1',
      turnNumber: 1,
      tone: 'success',
      artifactOwnership: [{ kind: 'file', label: 'report.md', path: '/repo/app/report.md', ownerKind: 'tool', ownerLabel: 'Write' }],
    };
    previewItemsState.items = [{
      id: 'file:/repo/app/report.md',
      kind: 'document',
      title: 'report.md',
      status: 'ready',
      createdAt: 1,
      source: { kind: 'tool', label: 'Write' },
      file: { path: '/repo/app/report.md', name: 'report.md' },
    }] as never;
    setRun('completed');

    render(<TaskWorkspaceOverview />);
    const root = screen.getByTestId('task-workspace-overview');
    const order = Array.from(root.querySelectorAll('[data-module]')).map((el) => el.getAttribute('data-module'));

    expect(order).toEqual(['task', 'todo', 'context', 'artifacts']);
    // 诊断 UI 整体删除
    expect(screen.queryByTestId('overview-diagnostics-body')).toBeNull();
    expect(screen.queryByText('诊断详情')).toBeNull();
  });

  it('无 TODO 时 Todo 模块不渲染（不摆占位）', () => {
    render(<TaskWorkspaceOverview />);
    expect(screen.queryByTestId('overview-todo-module')).toBeNull();
  });

  it('无上下文时上下文模块不渲染', () => {
    render(<TaskWorkspaceOverview />);
    expect(screen.queryByTestId('overview-context-module')).toBeNull();
  });
});

describe('Todo 模块：readFailure 空态化与互斥（C.11）', () => {
  it('0 rows 误报：读取失败标记 + 无任务 + 已完成 → 不渲染失败横幅，Todo 模块按空态不渲染', () => {
    backgroundTaskStore.readFailure = { message: 'ledger unavailable', failedAt: Date.now() };
    setRun('completed');

    render(<TaskWorkspaceOverview />);
    expect(screen.queryByText('无法确认后台命令任务的状态')).toBeNull();
    expect(screen.queryByTestId('overview-todo-module')).toBeNull();
  });

  it('真读取失败（确有任务在跑）在 Todo 模块位置内联一行错误 + 重试/取消', () => {
    backgroundTaskStore.readFailure = { message: 'ledger unavailable', failedAt: Date.now() };
    runWorkbenchState.tasks = [{
      id: 'background:task-1', scope: 'global', title: '后台任务', status: 'in_progress',
      steps: [], ownerRunId: null, sourceThreadId: 'session-1',
    }];

    render(<TaskWorkspaceOverview />);
    const todoModule = screen.getByTestId('overview-todo-module');
    expect(todoModule.textContent).toContain('无法确认后台命令任务的状态');
    expect(screen.queryByRole('button', { name: '重试读取' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: '取消任务' })).not.toBeNull();
    // 不暴露内部错误原文
    expect(screen.queryByText('ledger unavailable')).toBeNull();
  });

  it('与完成态互斥：run 已 completed 时不允许同屏出现错误横幅', () => {
    backgroundTaskStore.readFailure = { message: 'ledger unavailable', failedAt: Date.now() };
    runWorkbenchState.tasks = [{
      id: 'background:task-1', scope: 'global', title: '后台任务', status: 'in_progress',
      steps: [], ownerRunId: null, sourceThreadId: 'session-1',
    }];
    setRun('completed');

    render(<TaskWorkspaceOverview />);
    expect(screen.queryByText('无法确认后台命令任务的状态')).toBeNull();
  });
});

describe('上下文模块：每类上限与 +N 展开', () => {
  it('每类最多 5 行，超出收「+N」尾行，点开展开', () => {
    statusRailState.context.items = Array.from({ length: 7 }, (_, index) => ({
      id: `f${index}`,
      label: `file-${index}.md`,
      detail: 'Read',
      bucket: 'files',
      source: 'tool',
      path: `/repo/app/file-${index}.md`,
    })) as never;

    render(<TaskWorkspaceOverview />);
    const contextModule = screen.getByTestId('overview-context-module');
    const rows = contextModule.querySelectorAll('[data-testid="overview-context-row"]');
    expect(rows).toHaveLength(5);

    const more = screen.getByTestId('overview-context-more-file');
    expect(more.textContent).toContain('2');
    fireEvent.click(more);
    expect(contextModule.querySelectorAll('[data-testid="overview-context-row"]')).toHaveLength(7);
  });
});

describe('产物模块：完成态收拢缩略行', () => {
  const ownership = [
    { kind: 'file', label: 'pricing-chart.png', path: '/repo/app/pricing-chart.png', ownerKind: 'tool', ownerLabel: 'image_generate' },
    { kind: 'file', label: 'report.md', path: '/repo/app/report.md', ownerKind: 'tool', ownerLabel: 'Write' },
  ];

  beforeEach(() => {
    artifactOwnershipState.current = {
      turnId: 'turn-1', turnNumber: 1, tone: 'success', artifactOwnership: ownership as never,
    };
    previewItemsState.items = [{
      id: 'file:/repo/app/pricing-chart.png',
      kind: 'image',
      title: 'pricing-chart.png',
      status: 'ready',
      createdAt: 1,
      source: { kind: 'tool', label: 'image_generate' },
      file: { path: '/repo/app/pricing-chart.png', name: 'pricing-chart.png', size: 216_678 },
    }, {
      id: 'file:/repo/app/report.md',
      kind: 'document',
      title: 'report.md',
      status: 'ready',
      createdAt: 1,
      source: { kind: 'tool', label: 'Write' },
      file: { path: '/repo/app/report.md', name: 'report.md' },
    }] as never;
  });

  it('跑中不铺产物列表（整个模块不渲染）', () => {
    setRun('running');
    render(<TaskWorkspaceOverview />);
    expect(screen.queryByTestId('overview-artifacts-module')).toBeNull();
  });

  it('完成态收拢为一排缩略行：文件名 + 大小，图片给真缩略图', () => {
    setRun('completed');
    render(<TaskWorkspaceOverview />);

    const module = screen.getByTestId('overview-artifacts-module');
    const thumbs = module.querySelectorAll('[data-testid="overview-artifact-thumb"]');
    expect(thumbs).toHaveLength(2);
    expect(module.textContent).toContain('pricing-chart.png');
    expect(module.textContent).toContain('report.md');
    // 图片产物渲染真缩略图（<img>），非图片走类型图标
    const img = module.querySelector('img[alt="pricing-chart.png"]');
    expect(img).not.toBeNull();
    expect(module.textContent).toContain('212 KB');
  });

  it('缩略图加载失败降级为类型图标（不渲染灰底问号裂图）', () => {
    setRun('completed');
    render(<TaskWorkspaceOverview />);

    const img = screen.getByTestId('overview-artifacts-module').querySelector('img[alt="pricing-chart.png"]');
    expect(img).not.toBeNull();
    fireEvent.error(img!);
    expect(screen.getByTestId('overview-artifacts-module').querySelector('img')).toBeNull();
  });

  it('点击缩略行一步直达文件 preview tab', () => {
    setRun('completed');
    render(<TaskWorkspaceOverview />);

    fireEvent.click(screen.getAllByTestId('overview-artifact-thumb')[0]);
    expect(appState.openPreview).toHaveBeenCalledWith('/repo/app/pricing-chart.png');
    expect(appState.openWorkspacePreview).not.toHaveBeenCalled();
  });

  it('纯文本产物一步直达内容 preview tab；无预览体条目不渲染为按钮', () => {
    previewItemsState.items = [{
      id: 'process-output-1',
      kind: 'trace',
      title: '执行结果',
      status: 'ready',
      createdAt: 2,
      source: { kind: 'tool', label: 'process' },
      content: { summary: '三步已完成' },
    }, {
      id: 'empty-output-1',
      kind: 'trace',
      title: '空输出',
      status: 'ready',
      createdAt: 1,
      source: { kind: 'tool', label: 'process' },
    }] as never;
    setRun('completed');
    render(<TaskWorkspaceOverview />);

    fireEvent.click(screen.getByRole('button', { name: /执行结果/ }));
    expect(appState.openContentPreview).toHaveBeenCalledWith({
      id: 'process-output-1',
      title: '执行结果',
      content: '三步已完成',
      format: 'markdown',
    });
    expect(screen.getByTestId('overview-artifact-thumb-static').textContent).toContain('空输出');
  });

  it('产物标签为人话（内部 ID 兜底「未命名输出」）', () => {
    previewItemsState.items = [{
      id: 'process-output-1',
      kind: 'trace',
      title: 'tool-result-tool-775064011',
      status: 'ready',
      createdAt: 1,
      source: { kind: 'tool', label: 'Blob' },
      content: { summary: 'done' },
    }] as never;
    setRun('completed');
    render(<TaskWorkspaceOverview />);

    const module = screen.getByTestId('overview-artifacts-module');
    expect(module.textContent).toContain('未命名输出');
    expect(module.textContent).not.toContain('775064011');
  });
});

// ============================================================================
// C2 概览 Todo 成员级全透明（2026-08-05）
// ============================================================================
// 此前 Todo 长期显示 `执行 bash` 这类工具流水（buildSessionTaskRecord 在没有
// 结构化 todos 时拿 taskProgress.step 伪造一条，而 step 的兜底串来自
// toolExecutionEngine 的 `执行 ${toolCall.name}`）；成员在跑什么完全不透明。
describe('Todo 模块：组队会话成员级清单', () => {
  const members = [
    {
      id: 'agent-a',
      parentRunId: 'run-1',
      role: '知微',
      status: 'running',
      inputSummary: '拉竞品数据',
      lastOutput: '',
    },
    {
      id: 'agent-b',
      parentRunId: 'run-1',
      role: '青禾',
      status: 'completed',
      inputSummary: '写摘要',
      lastOutput: '已交稿',
    },
  ];

  it('主会话没有结构化 todos 时，Todo 模块照样按成员铺清单', () => {
    runWorkbenchState.subagents = members as never;
    memberPills.pills = [
      { key: 'agent-a', roleId: 'analyst', name: '知微', status: 'running', isLead: false },
      { key: 'agent-b', roleId: 'writer', name: '青禾', status: 'completed', isLead: false },
    ];

    render(<TaskWorkspaceOverview />);

    const todoModule = screen.getByTestId('overview-todo-module');
    expect(todoModule.textContent).toContain('知微');
    expect(todoModule.textContent).toContain('青禾');
    expect(todoModule.textContent).toContain('拉竞品数据');
    expect(screen.getAllByTestId('subagent-run-row')).toHaveLength(2);
  });

  it('点成员行直达成员视图', () => {
    runWorkbenchState.subagents = members as never;
    memberPills.pills = [
      { key: 'agent-a', roleId: 'analyst', name: '知微', status: 'running', isLead: false },
      { key: 'agent-b', roleId: 'writer', name: '青禾', status: 'completed', isLead: false },
    ];

    render(<TaskWorkspaceOverview />);
    fireEvent.click(screen.getAllByTestId('subagent-run-row')[1]);

    expect(memberViewState.setViewingMemberId).toHaveBeenCalledWith('agent-b');
  });

  // workflow 子 agent 也在 runWorkbench.subagents 里，而 workflow 快照对「无 sessionId
  // 的注入项」跨会话可见——不过滤就会让非组队会话也长出 Todo 模块（e2e 实测）。
  it('只渲染本会话成员：解析不出成员的行整条不出现', () => {
    runWorkbenchState.subagents = members as never;
    memberPills.pills = [
      { key: 'agent-a', roleId: 'analyst', name: '知微', status: 'running', isLead: false },
    ];

    render(<TaskWorkspaceOverview />);
    expect(screen.getAllByTestId('subagent-run-row')).toHaveLength(1);
    expect(screen.getByTestId('overview-todo-module').textContent).not.toContain('青禾');
  });

  it('一个成员都解析不出来时，Todo 模块不因 subagents 而出现', () => {
    runWorkbenchState.subagents = members as never;
    memberPills.pills = [];
    runWorkbenchState.tasks = [];

    render(<TaskWorkspaceOverview />);
    expect(screen.queryByTestId('overview-todo-module')).toBeNull();
  });

  it('非组队会话且无 todos：Todo 模块不渲染（不再有伪造的「执行 xxx」条目）', () => {
    runWorkbenchState.subagents = [];
    runWorkbenchState.tasks = [];

    render(<TaskWorkspaceOverview />);

    expect(screen.queryByTestId('overview-todo-module')).toBeNull();
  });
});
