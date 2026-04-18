import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const appState = {
  workingDirectory: '/repo/app',
  sessionTaskProgress: {},
  processingSessionIds: new Set<string>(),
};

const sessionState = {
  currentSessionId: 'session-1',
  messages: [],
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
        workIn: '工作于 {folderName}',
        sectionTodos: '待办',
        todosEmpty: '暂无待办',
        sectionContext: '上下文',
        sectionOutputs: '产物',
        artifactsEmpty: '没有产物',
        sectionReferences: '引用',
        skillsMcpEmpty: '没有技能',
        phaseRead: '读取文件',
        phaseEdit: '写入文件',
        phaseExecute: '执行命令',
        phaseSearch: '搜索信息',
        phaseMcp: '调用工具',
        phaseOps: '{count} 次操作',
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
    context: {
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
    },
    compact: {
      canCompact: false,
      compressionCount: 0,
      totalSavedTokens: 0,
    },
    todos: {
      items: [],
      completed: 0,
      total: 0,
    },
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

  it('renders the current turn capability scope with the same four layers used by chat trace', () => {
    const html = renderToStaticMarkup(
      React.createElement(TaskMonitor),
    );

    expect(html).toContain('当前 Turn Scope');
    expect(html).toContain('当前 Turn Routing');
    expect(html).toContain('Scope Inspector Lite');
    expect(html).toContain('Routing 证据');
    expect(html).toContain('本轮输出');
    expect(html).toContain('Execution Chart');
    expect(html).toContain('report.md');
    expect(html).toContain('reviewer · Write');
    expect(html).toContain('User Selected');
    expect(html).toContain('Runtime Allowed');
    expect(html).toContain('Runtime Blocked');
    expect(html).toContain('Actually Invoked');
    expect(html).toContain('Direct 已发送给 reviewer');
    expect(html).toContain('用户显式指定 reviewer');
    expect(html).toContain('已发送给 reviewer');
    expect(html).toContain('Direct');
    expect(html).toContain('draft-skill');
    expect(html).toContain('Mail');
    expect(html).toContain('skill_not_mounted');
    expect(html).toContain('去 TaskPanel/Skills 把它挂到当前会话。');
    expect(html).toContain('send');
    expect(html).toContain('挂载');
    expect(html).toContain('#2');
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
