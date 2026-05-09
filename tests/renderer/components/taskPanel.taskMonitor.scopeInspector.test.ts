
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const appState = {
  workingDirectory: '/repo/app',
  sessionTaskProgress: {} as Record<string, any>,
  processingSessionIds: new Set<string>(),
};

const sessionState = {
  currentSessionId: 'session-1',
  messages: [] as Array<any>,
  sessionDesignBriefs: new Map<string, any>(),
};

const statusRailTodosState = {
  items: [] as Array<any>,
  completed: 0,
  total: 0,
};

const statusRailContextState = {
  currentTokens: 3200,
  maxTokens: 128000,
  usagePercent: 3,
  warningLevel: 'normal' as const,
  buckets: {
    rules: 1,
    files: 0,
    web: 0,
    other: 0,
  },
  items: [] as Array<any>,
};

const currentTurnScopeState = {
  turnId: 'turn-2',
  turnNumber: 2,
  tone: 'warning',
  selectedCapabilities: [
    {
      kind: 'skill',
      key: 'skill:draft-skill',
      id: 'draft-skill',
      label: 'draft-skill',
      selected: true,
      mounted: false,
      installState: 'available',
      description: 'Draft release notes',
      source: 'community',
      libraryId: 'community',
      available: false,
      blocked: true,
      visibleInWorkbench: true,
      health: 'inactive',
      lifecycle: {
        installState: 'installed',
        mountState: 'unmounted',
        connectionState: 'not_applicable',
      },
      blockedReason: {
        code: 'skill_not_mounted',
        detail: 'Skill draft-skill 已安装但未挂载，本轮不会调用。',
        hint: '去 TaskPanel/Skills 把它挂到当前会话。',
        severity: 'warning',
      },
    },
  ],
  blockedCapabilities: [
    {
      kind: 'skill',
      key: 'skill:draft-skill',
      id: 'draft-skill',
      label: 'draft-skill',
      selected: true,
      mounted: false,
      installState: 'available',
      description: 'Draft release notes',
      source: 'community',
      libraryId: 'community',
      available: false,
      blocked: true,
      visibleInWorkbench: true,
      health: 'inactive',
      lifecycle: {
        installState: 'installed',
        mountState: 'unmounted',
        connectionState: 'not_applicable',
      },
      blockedReason: {
        code: 'skill_not_mounted',
        detail: 'Skill draft-skill 已安装但未挂载，本轮不会调用。',
        hint: '去 TaskPanel/Skills 把它挂到当前会话。',
        severity: 'warning',
      },
    },
  ],
  scope: {
    selected: [
      {
        kind: 'skill',
        id: 'draft-skill',
        label: 'draft-skill',
      },
      {
        kind: 'connector',
        id: 'mail',
        label: 'Mail',
      },
    ],
    allowed: [
      {
        kind: 'connector',
        id: 'mail',
        label: 'Mail',
      },
    ],
    blocked: [
      {
        kind: 'skill',
        id: 'draft-skill',
        label: 'draft-skill',
        code: 'skill_not_mounted',
        detail: 'Skill draft-skill 已安装但未挂载，本轮不会调用。',
        hint: '去 TaskPanel/Skills 把它挂到当前会话。',
        severity: 'warning',
      },
    ],
    invoked: [
      {
        kind: 'connector',
        id: 'mail',
        label: 'Mail',
        count: 1,
        topActions: [{ label: 'send', count: 1 }],
      },
    ],
  },
};

const currentTurnRoutingState = {
  turnId: 'turn-2',
  turnNumber: 2,
  tone: 'success' as const,
  routingEvidence: {
    mode: 'direct' as const,
    summary: 'Direct 已发送给 reviewer',
    reason: '用户显式指定 reviewer',
    steps: [
      {
        status: 'delivered' as const,
        label: '已发送给 reviewer',
        tone: 'success' as const,
      },
    ],
  },
};

const currentTurnArtifactState = {
  turnId: 'turn-2',
  turnNumber: 2,
  tone: 'success' as const,
  artifactOwnership: [
    {
      kind: 'artifact' as const,
      label: 'Execution Chart',
      ownerKind: 'assistant' as const,
      ownerLabel: 'reviewer',
    },
    {
      kind: 'file' as const,
      label: 'report.md',
      ownerKind: 'tool' as const,
      ownerLabel: 'reviewer · Write',
      path: '/repo/app/report.md',
    },
  ],
};

const quickActionRunnerState = {
  runningActionKey: null as string | null,
  actionErrors: {} as Record<string, string>,
  completedActions: {} as Record<string, { kind: string; completedAt: number }>,
  runQuickAction: vi.fn(),
};

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({
    t: {
      taskPanel: {
        progress: '进度',
        workIn: '工作于 {folderName}',
        sectionTodos: '待办',
        todosEmpty: '暂无待办',
        sectionContext: '上下文',
        sectionOutputs: '产物',
        artifactsEmpty: '没有产物',
        sectionReferences: '引用',
        skillsMcpEmpty: '没有技能',
        progressEmpty: '暂无任务计划',
        phaseThinking: '分析请求中',
        phaseGenerating: '生成回复中',
        phaseToolPending: '准备执行',
        phaseToolRunning: '执行工具中',
        phaseCompleted: '回复完成',
        phaseFailed: '任务失败',
        phaseRead: '读取文件',
        phaseEdit: '写入文件',
        phaseExecute: '执行命令',
        phaseSearch: '搜索信息',
        phaseMcp: '调用工具',
        phaseOps: '{count} 次操作',
        taskProgressTool: '工具：{tool}',
        taskProgressToolPosition: '第 {index}/{total} 个工具',
        toolActivity: '工具活动',
        toolActivityRead: '文件读取活动',
        toolActivityEdit: '文件写入活动',
        toolActivityExecute: '命令执行活动',
        toolActivitySearch: '搜索活动',
        toolActivityMcp: '外部工具活动',
        toolActivityOps: '{count} 次工具操作',
        bucketRules: 'Rules',
        bucketFiles: 'Files',
        bucketWeb: 'Web',
        bucketOther: 'Other',
      },
    },
  }),
}));

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector?: (state: typeof sessionState) => unknown) => (
    selector ? selector(sessionState) : sessionState
  ),
}));

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector?: (state: typeof appState) => unknown) => (
    selector ? selector(appState) : appState
  ),
}));

vi.mock('../../../src/renderer/hooks/useStatusRailModel', () => ({
  useStatusRailModel: () => ({
    context: statusRailContextState,
    compact: {
      canCompact: false,
      compressionCount: 0,
      totalSavedTokens: 0,
    },
    todos: statusRailTodosState,
    outputs: {
      files: [],
      count: 0,
    },
    swarm: {
      isRunning: false,
      agentCount: 0,
      selectedAgentId: null,
    },
    cache: {
      promptCacheHits: 0,
      promptCacheMisses: 0,
      totalCachedTokens: 0,
      hitRate: 0,
    },
  }),
}));

vi.mock('../../../src/renderer/hooks/useWorkbenchInsights', () => ({
  useWorkbenchInsights: () => ({
    references: [
      {
        kind: 'mcp' as const,
        id: 'github',
        label: 'github',
        selected: false,
        status: 'connected' as const,
        enabled: true,
        transport: 'stdio' as const,
        toolCount: 2,
        resourceCount: 1,
        invoked: true,
      },
    ],
    history: [
      {
        kind: 'connector' as const,
        id: 'mail',
        label: 'Mail',
        count: 1,
        lastUsed: 200,
        topActions: [{ label: 'send', count: 1 }],
      },
      {
        kind: 'mcp' as const,
        id: 'github',
        label: 'github',
        count: 1,
        lastUsed: 210,
        topActions: [{ label: 'search_code', count: 1 }],
      },
    ],
  }),
}));

vi.mock('../../../src/renderer/components/TaskPanel/useToolProgress', () => ({
  useToolProgress: () => ({
    toolProgress: null,
    toolTimeout: null,
  }),
}));

vi.mock('../../../src/renderer/hooks/useCurrentTurnCapabilityScope', () => ({
  useCurrentTurnCapabilityScope: () => currentTurnScopeState,
}));

vi.mock('../../../src/renderer/hooks/useCurrentTurnRoutingEvidence', () => ({
  useCurrentTurnRoutingEvidence: () => currentTurnRoutingState,
}));

vi.mock('../../../src/renderer/hooks/useCurrentTurnArtifactOwnership', () => ({
  useCurrentTurnArtifactOwnership: () => currentTurnArtifactState,
}));

vi.mock('../../../src/renderer/hooks/useWorkbenchCapabilityQuickActionRunner', () => ({
  useWorkbenchCapabilityQuickActionRunner: () => quickActionRunnerState,
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: vi.fn(),
  },
}));

import { TaskMonitor } from '../../../src/renderer/components/TaskPanel/TaskMonitor';

describe('TaskMonitor scope inspector slice', () => {
  beforeEach(() => {
    appState.sessionTaskProgress = {};
    appState.processingSessionIds = new Set<string>();
    sessionState.messages = [];
    statusRailTodosState.items = [];
    statusRailTodosState.completed = 0;
    statusRailTodosState.total = 0;
    Object.assign(statusRailContextState, {
      currentTokens: 3200,
      maxTokens: 128000,
      usagePercent: 3,
      warningLevel: 'normal',
      buckets: {
        rules: 1,
        files: 0,
        web: 0,
        other: 0,
      },
      items: [],
    });
    currentTurnScopeState.selectedCapabilities[0] = {
      kind: 'skill',
      key: 'skill:draft-skill',
      id: 'draft-skill',
      label: 'draft-skill',
      selected: true,
      mounted: false,
      installState: 'available',
      description: 'Draft release notes',
      source: 'community',
      libraryId: 'community',
      available: false,
      blocked: true,
      visibleInWorkbench: true,
      health: 'inactive',
      lifecycle: {
        installState: 'installed',
        mountState: 'unmounted',
        connectionState: 'not_applicable',
      },
      blockedReason: {
        code: 'skill_not_mounted',
        detail: 'Skill draft-skill 已安装但未挂载，本轮不会调用。',
        hint: '去 TaskPanel/Skills 把它挂到当前会话。',
        severity: 'warning',
      },
    };
    currentTurnScopeState.blockedCapabilities = [currentTurnScopeState.selectedCapabilities[0]];
    quickActionRunnerState.completedActions = {};
    quickActionRunnerState.actionErrors = {};
  });

  it('folds live session progress into Tasks when there are no todos', () => {
    appState.sessionTaskProgress = {
      'session-1': {
        turnId: 'turn-2',
        phase: 'generating',
        step: '生成文档中',
        tool: 'Read',
        toolIndex: 0,
        toolTotal: 3,
      },
    };
    sessionState.messages = [
      {
        toolCalls: [
          { name: 'Read', arguments: { path: '/repo/app/brief.md' } },
          { name: 'Read', arguments: { path: '/repo/app/report.md' } },
        ],
      },
    ];

    const html = renderToStaticMarkup(
      React.createElement(TaskMonitor),
    );

    expect(html).toContain('生成文档中');
    expect(html).toContain('工具：Read');
    expect(html).toContain('第 1/3 个工具');
    expect(html).not.toContain('读取文件');
    expect(html).not.toContain('文件读取活动');
  });

  it('keeps Task as the primary rail section when there are no todos or task progress', () => {
    sessionState.messages = [
      {
        toolCalls: [
          { name: 'Read', arguments: { path: '/repo/app/brief.md' } },
          { name: 'Read', arguments: { path: '/repo/app/report.md' } },
        ],
      },
    ];

    const html = renderToStaticMarkup(
      React.createElement(TaskMonitor),
    );

    expect(html).toContain('任务');
    expect(html).toContain('暂无任务');
    expect(html).not.toContain('Activity');
    expect(html).not.toContain('暂无任务计划');
    expect(html).not.toContain('工具活动');
    expect(html).not.toContain('文件读取活动');
    expect(html).not.toContain('2 次工具操作');
  });

  it('keeps sub-1% context usage visible in the right rail', () => {
    Object.assign(statusRailContextState, {
      currentTokens: 1536,
      maxTokens: 1048576,
      usagePercent: 0.1,
      buckets: {
        rules: 0,
        files: 5,
        web: 0,
        other: 53,
      },
    });

    const html = renderToStaticMarkup(
      React.createElement(TaskMonitor),
    );

    expect(html).toContain('0.1%');
    expect(html).not.toContain('1.5k / 1048.6k tokens');
    expect(html).not.toContain('Files 5');
    expect(html).not.toContain('Other 53');
    expect(html).not.toContain('其他 53');
  });

  it('counts context files by unique file identity and hides other sources', () => {
    Object.assign(statusRailContextState, {
      currentTokens: 12500,
      maxTokens: 1048576,
      usagePercent: 1.2,
      warningLevel: 'warning',
      buckets: {
        rules: 0,
        files: 99,
        web: 0,
        other: 99,
      },
      items: [
        {
          id: 'write-html',
          label: 'breakout-cu.html',
          detail: 'Write',
          bucket: 'files',
          source: 'tool',
          path: '/tmp/raiden_test/breakout-cu.html',
        },
        {
          id: 'read-html',
          label: 'breakout-cu.html',
          detail: 'Read',
          bucket: 'files',
          source: 'tool',
          path: '/tmp/raiden_test/breakout-cu.html',
        },
        {
          id: 'edit-html',
          label: 'breakout-cu.html',
          detail: 'Edit',
          bucket: 'files',
          source: 'tool',
          path: '/tmp/raiden_test/breakout-cu.html',
        },
        {
          id: 'read-validation',
          label: 'validation-result.json',
          detail: 'Read',
          bucket: 'files',
          source: 'tool',
          path: '/tmp/raiden_test/validation-result.json',
        },
        {
          id: 'bash-output',
          label: 'Bash output',
          detail: 'Bash',
          bucket: 'other',
          source: 'tool',
        },
      ],
    });

    const html = renderToStaticMarkup(
      React.createElement(TaskMonitor),
    );

    expect(html).toContain('文件 2');
    expect(html).not.toContain('文件 99');
    expect(html).not.toContain('其他');
  });

  it('keeps todos primary while preserving live task progress', () => {
    statusRailTodosState.items = [
      {
        status: 'in_progress',
        content: '生成文档',
        activeForm: '正在生成文档',
      },
    ];
    statusRailTodosState.completed = 0;
    statusRailTodosState.total = 1;
    appState.sessionTaskProgress = {
      'session-1': {
        turnId: 'turn-2',
        phase: 'generating',
        step: '生成回复中',
      },
    };
    sessionState.messages = [
      {
        toolCalls: [
          { name: 'Read', arguments: { path: '/repo/app/brief.md' } },
        ],
      },
    ];

    const html = renderToStaticMarkup(
      React.createElement(TaskMonitor),
    );

    expect(html).toContain('正在生成文档');
    expect(html).toContain('生成回复中');
    expect(html).not.toContain('0/1 steps');
    expect(html).not.toContain('工具活动');
    expect(html).not.toContain('文件读取活动');
  });

  it('prioritizes active and pending plan items while folding completed items', () => {
    statusRailTodosState.items = [
      { status: 'completed', content: '已完成一', activeForm: '已完成一' },
      { status: 'completed', content: '已完成二', activeForm: '已完成二' },
      { status: 'completed', content: '已完成三', activeForm: '已完成三' },
      { status: 'completed', content: '已完成四', activeForm: '已完成四' },
      { status: 'in_progress', content: '改造任务卡展示', activeForm: '正在改造任务卡展示' },
      { status: 'pending', content: '补 helper 单测', activeForm: '补 helper 单测' },
      { status: 'pending', content: '补组件测试', activeForm: '补组件测试' },
      { status: 'pending', content: '跑定向测试', activeForm: '跑定向测试' },
      { status: 'pending', content: '跑 typecheck', activeForm: '跑 typecheck' },
      { status: 'pending', content: '回读结果', activeForm: '回读结果' },
    ];
    statusRailTodosState.completed = 4;
    statusRailTodosState.total = 10;
    appState.sessionTaskProgress = {
      'session-1': {
        turnId: 'turn-2',
        phase: 'generating',
        step: '生成回复中',
      },
    };

    const html = renderToStaticMarkup(
      React.createElement(TaskMonitor),
    );

    expect(html).toContain('4/10');
    expect(html).toContain('正在改造任务卡展示');
    expect(html).toContain('补 helper 单测');
    expect(html).toContain('回读结果');
    expect(html).toContain('已完成 4 项');
    expect(html).not.toContain('已完成一');
    expect(html).not.toContain('0/1 steps');
  });

  it('renders task-first rail with context and MCP split from capability sources', () => {
    const html = renderToStaticMarkup(
      React.createElement(TaskMonitor),
    );

    expect(html).toContain('任务');
    expect(html).not.toContain('Activity');
    expect(html).not.toContain('来源');
    expect(html).not.toContain('连接');
    expect(html).toContain('上下文');
    expect(html).toContain('MCP');
    expect(html).toContain('当前能力');
    expect(html).not.toContain('当前 Turn Routing');
    expect(html).toContain('Scope Inspector Lite');
    expect(html).not.toContain('Routing 证据');
    expect(html).not.toContain('本轮输出');
    expect(html).toContain('Execution Chart');
    expect(html).toContain('report.md');
    expect(html).toContain('reviewer · Write');
    expect(html).toContain('User Selected');
    expect(html).toContain('Runtime Allowed');
    expect(html).toContain('Runtime Blocked');
    expect(html).toContain('Actually Invoked');
    expect(html).not.toContain('Direct 已发送给 reviewer');
    expect(html).not.toContain('用户显式指定 reviewer');
    expect(html).not.toContain('已发送给 reviewer');
    expect(html).toContain('draft-skill');
    expect(html).toContain('Mail');
    expect(html).toContain('skill_not_mounted');
    expect(html).toContain('去 TaskPanel/Skills 把它挂到当前会话。');
    expect(html).toContain('send');
    expect(html).toContain('挂载');
    expect(html).not.toContain('#2 ·');
    expect(html).toContain('查看 draft-skill 详情');
    expect(html).toContain('查看 github 详情');
  });

  it('shows repaired feedback when the historical blocked capability is now available', () => {
    currentTurnScopeState.selectedCapabilities = [
      {
        kind: 'skill',
        key: 'skill:draft-skill',
        id: 'draft-skill',
        label: 'draft-skill',
        selected: true,
        mounted: true,
        installState: 'mounted',
        description: 'Draft release notes',
        source: 'community',
        libraryId: 'community',
        available: true,
        blocked: false,
        visibleInWorkbench: true,
        health: 'healthy',
        lifecycle: {
          installState: 'installed',
          mountState: 'mounted',
          connectionState: 'not_applicable',
        },
      },
    ];
    currentTurnScopeState.blockedCapabilities = [];
    quickActionRunnerState.completedActions = {
      'skill:draft-skill': {
        kind: 'mount_skill',
        completedAt: 1,
      },
    };

    const html = renderToStaticMarkup(
      React.createElement(TaskMonitor),
    );

    expect(html).toContain('当前已修复，下条消息可用。');
  });
});
