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
  openWorkspacePreview: vi.fn(),
  setSelectedWorkspacePreviewId: vi.fn(),
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
  appState.openWorkspacePreview.mockReset();
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
    expect(screen.queryByText('无法确认任务状态')).toBeNull();
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
    expect(todoModule.textContent).toContain('无法确认任务状态');
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
    expect(screen.queryByText('无法确认任务状态')).toBeNull();
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

  it('点击缩略行进专注预览（沿用 selectedWorkspacePreviewId 链路）', () => {
    setRun('completed');
    render(<TaskWorkspaceOverview />);

    fireEvent.click(screen.getAllByTestId('overview-artifact-thumb')[0]);
    expect(appState.openWorkspacePreview).toHaveBeenCalledWith('file:/repo/app/pricing-chart.png');
  });

  it('产物标签为人话（内部 ID 兜底「未命名输出」）', () => {
    artifactOwnershipState.current = {
      turnId: 'turn-1',
      turnNumber: 1,
      tone: 'success',
      artifactOwnership: [{
        kind: 'artifact', label: 'tool-result-tool-775064011', ownerKind: 'tool', ownerLabel: 'Blob',
      }] as never,
    };
    setRun('completed');
    render(<TaskWorkspaceOverview />);

    const module = screen.getByTestId('overview-artifacts-module');
    expect(module.textContent).toContain('未命名输出');
    expect(module.textContent).not.toContain('775064011');
  });
});
