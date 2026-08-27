// @vitest-environment jsdom

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const sendMessageMock = vi.hoisted(() => vi.fn(async () => {}));
const ipcInvokeMock = vi.hoisted(() => vi.fn(async () => undefined));

const sessionState = {
  currentSessionId: 'session-1',
  hasOlderMessages: false,
  isLoadingOlder: false,
  loadOlderMessages: vi.fn(async () => {}),
  sessions: [
    {
      id: 'session-1',
      title: '继续推进 Phase 5',
      modelConfig: { provider: 'openai', model: 'gpt-5.4' },
      createdAt: Date.now() - 20_000,
      updatedAt: Date.now() - 5_000,
      workingDirectory: '/repo/code-agent',
      messageCount: 6,
      turnCount: 2,
      workbenchSnapshot: {
        summary: '工作区 · Browser',
        labels: ['工作区', 'Browser'],
        recentToolNames: ['browser_action'],
      },
    },
  ] as unknown[],
  sessionRuntimes: new Map([
    ['session-1', { sessionId: 'session-1', status: 'paused', activeAgentCount: 0, contextHealth: null, lastActivityAt: Date.now() - 3_000 }],
  ]),
  backgroundSessions: [],
  pendingUserQuestionsBySessionId: new Map<string, unknown[]>(),
  moveToBackground: vi.fn(async () => true),
};

const appState = {
  showPreviewPanel: false,
  workingDirectory: '/repo/other',
  goalRuns: {},
  setTaskPlan: vi.fn(),
  setShowSettings: vi.fn(),
  openSettingsTab: vi.fn(),
};

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: Object.assign(
    (selector?: (state: typeof appState) => unknown) => selector ? selector(appState) : appState,
    {
      getState: () => ({
        setWorkingDirectory: vi.fn(),
      }),
    },
  ),
}));

vi.mock('../../../src/renderer/stores/composerStore', () => ({
  useComposerStore: (selector?: (state: { buildContext: () => object; hydrateFromSession: (...args: unknown[]) => void }) => unknown) => selector
    ? selector({
      buildContext: () => ({}),
      hydrateFromSession: vi.fn(),
    })
    : {
      buildContext: () => ({}),
      hydrateFromSession: vi.fn(),
    },
}));

vi.mock('../../../src/renderer/stores/sessionStore', async (importOriginal) => ({
  // 纯谓词（isBlankNewSession 等）走真实实现：NewSessionWelcome 用它判「这是不是真新会话」，
  // 打桩会让空态首屏的消歧在这里测成空气。
  ...(await importOriginal<typeof import('../../../src/renderer/stores/sessionStore')>()),
  useSessionStore: Object.assign(
    (selector?: (state: typeof sessionState) => unknown) => selector ? selector(sessionState) : sessionState,
    {
      getState: () => ({
        ...sessionState,
        clearPendingUserQuestion: (request: { id: string; sessionId?: string }) => {
          const sessionId = request.sessionId ?? sessionState.currentSessionId;
          if (!sessionId) return;
          const next = new Map(sessionState.pendingUserQuestionsBySessionId);
          next.set(sessionId, (next.get(sessionId) ?? []).filter((item) => (
            (item as { id?: string }).id !== request.id
          )));
          sessionState.pendingUserQuestionsBySessionId = next;
        },
      }),
    },
  ),
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: ipcInvokeMock,
    invokeDomain: vi.fn(async () => { throw new Error('test boundary'); }),
    on: vi.fn(() => () => {}),
  },
}));

vi.mock('../../../src/renderer/stores/taskStore', () => ({
  useTaskStore: (selector?: (state: { sessionStates: Record<string, unknown> }) => unknown) =>
    selector ? selector({ sessionStates: { 'session-1': { status: 'idle' } } }) : { sessionStates: { 'session-1': { status: 'idle' } } },
}));

vi.mock('../../../src/renderer/stores/modeStore', () => ({
  useModeStore: (selector?: (state: { isPaused: boolean; setIsPaused: (...args: unknown[]) => void }) => unknown) => selector
    ? selector({ isPaused: false, setIsPaused: vi.fn() })
    : { isPaused: false, setIsPaused: vi.fn() },
}));

const swarmStoreState = {
  launchRequests: [] as unknown[],
  statistics: { totalTokens: 0 },
  // D1：ChatView 用这三项判断「主 loop idle 但成员还在跑」
  agents: [] as Array<{ status: string }>,
  isRunning: false,
  activeSessionId: undefined as string | undefined,
};

vi.mock('../../../src/renderer/stores/swarmStore', () => ({
  useSwarmStore: (selector?: (state: typeof swarmStoreState) => unknown) =>
    selector ? selector(swarmStoreState) : swarmStoreState,
  // 判定抽成了共享 selector（ChatView 与成员条同一真源），整模块 mock 必须一并导出，
  // 否则 ChatView 渲染即抛 "No export is defined on the mock"。
  selectHasStoppableSwarmWork: (
    state: typeof swarmStoreState,
    sessionId?: string | null,
  ) => Boolean(sessionId)
    && state.activeSessionId === sessionId
    && (state.isRunning || state.agents.some(
      (agent) => agent.status === 'running' || agent.status === 'ready' || agent.status === 'pending',
    )),
}));

vi.mock('../../../src/renderer/stores/neoWorkCardStore', () => ({
  ensureNeoWorkCardLiveUpdates: vi.fn(),
  isNeoWorkCardAwaitingRuntimeTerminal: () => false,
  NEO_WORK_CARD_LIVE_REFRESH_MS: 1_000,
  selectNeoWorkCardDetailsForConversation: () => [],
  useNeoWorkCardStore: (selector: (state: { loadForConversation: () => Promise<void> }) => unknown) => (
    selector({ loadForConversation: vi.fn(async () => {}) })
  ),
}));

vi.mock('../../../src/renderer/stores/localBridgeStore', () => ({
  useLocalBridgeStore: () => ({
    status: 'connected',
    version: '0.1.0',
    workingDirectory: '/repo/other',
  }),
}));

vi.mock('../../../src/renderer/stores/messageActionStore', () => ({
  useMessageActionStore: (selector?: (state: { register: (...args: unknown[]) => void; unregister: () => void }) => unknown) => selector
    ? selector({ register: vi.fn(), unregister: vi.fn() })
    : { register: vi.fn(), unregister: vi.fn() },
}));

vi.mock('../../../src/renderer/hooks/useAgent', () => ({
  useAgent: () => ({
    messages: [],
    isProcessing: false,
    sendMessage: sendMessageMock,
    cancel: vi.fn(async () => {}),
    researchDetected: null,
    dismissResearchDetected: vi.fn(),
    isInterrupting: false,
  }),
}));

vi.mock('../../../src/renderer/hooks/useRequireAuth', () => ({
  useRequireAuth: () => ({
    requireAuthAsync: async (fn: () => unknown) => fn(),
  }),
}));

vi.mock('../../../src/renderer/hooks/useTurnProjection', () => ({
  useTurnProjection: () => ({ turns: [] }),
}));

vi.mock('../../../src/renderer/hooks/useTurnExecutionClarity', () => ({
  useTurnExecutionClarity: (projection: unknown) => projection,
}));

vi.mock('../../../src/renderer/components/features/chat/TurnBasedTraceView', () => ({
  TurnBasedTraceView: () => React.createElement('div', null, 'trace-view'),
}));

vi.mock('../../../src/renderer/components/brand/PlanetSphere', () => ({
  PlanetSphere: () => null,
}));

vi.mock('../../../src/renderer/components/features/chat/ActiveConversationRewindBanner', () => ({
  ActiveConversationRewindBanner: () => null,
}));

vi.mock('../../../src/renderer/components/features/surfaceExecution/SurfaceExecutionChatPanel', () => ({
  SurfaceExecutionChatPanel: () => null,
}));

vi.mock('../../../src/renderer/components/features/chat/ChatInput', () => ({
  ChatInput: React.forwardRef<unknown, {
    onSend: (envelope: { content: string; context: object }) => Promise<boolean>;
    placeholder?: string;
  }>(({ onSend, placeholder }, _ref) => {
    const [value, setValue] = React.useState('');
    return React.createElement(
      'form',
      {
        'data-testid': 'chat-input',
        onSubmit: (event: React.FormEvent) => {
          event.preventDefault();
          void onSend({ content: value, context: {} });
        },
      },
      React.createElement('input', {
        'aria-label': 'chat-input-field',
        value,
        placeholder,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => setValue(event.target.value),
      }),
      React.createElement('button', { type: 'submit' }, '发送'),
      React.createElement('span', null, 'chat-input'),
    );
  }),
}));

vi.mock('../../../src/renderer/components/features/chat/ChatInput/useFileUpload', () => ({
  useFileUpload: () => ({
    processFile: vi.fn(async () => null),
    processFolderEntry: vi.fn(async () => null),
  }),
}));

vi.mock('../../../src/renderer/components/features/chat/TaskStatusBar', () => ({
  TaskStatusBar: () => React.createElement('div', null, 'task-status-bar'),
}));

vi.mock('../../../src/renderer/components/features/chat/LocalBridgePrompt', () => ({
  LocalBridgePrompt: () => null,
}));

vi.mock('../../../src/renderer/components/features/chat/BridgeUpdatePrompt', () => ({
  BridgeUpdatePrompt: () => null,
}));

vi.mock('../../../src/renderer/components/features/chat/DirectoryPickerModal', () => ({
  DirectoryPickerModal: () => null,
}));

vi.mock('../../../src/renderer/components/features/chat/ChatSearchBar', () => ({
  ChatSearchBar: () => null,
}));

vi.mock('../../../src/renderer/components/features/chat/InlineStrip', () => ({
  InlineStrip: () => null,
}));

vi.mock('../../../src/renderer/components/PreviewPanel', () => ({
  PreviewPanel: () => null,
}));

vi.mock('../../../src/renderer/components/features/chat/SemanticResearchIndicator', () => ({
  SemanticResearchIndicator: () => null,
}));

vi.mock('../../../src/renderer/components/RewindPanel', () => ({
  RewindPanel: () => null,
}));

vi.mock('../../../src/renderer/utils/platform', () => ({
  isWebMode: () => false,
}));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

import { ChatView, buildDefaultSuggestions } from '../../../src/renderer/components/ChatView';
import { zh } from '../../../src/renderer/i18n/zh';

const defaultSuggestions = buildDefaultSuggestions(zh);

describe('ChatView session shell', () => {
  it('keeps session actions out of the chat body', () => {
    const html = renderToStaticMarkup(React.createElement(ChatView));

    expect(html).toContain('task-status-bar');
    expect(html).toContain('chat-input');
    expect(html).toContain('flex-1 min-h-0 flex overflow-hidden relative');
    expect(html).toContain('flex-1 min-h-0 flex flex-col min-w-0');
    expect(html).toContain('flex-1 min-h-0 overflow-hidden');
    // 2026-08-06 拍板：会话带了上下文（这个夹具带工作区 /repo/code-agent）就不摆通用
    // 建议卡——用户是带着目的进来的，贪吃蛇/图表这类与他手上的事无关的卡是噪音。
    // 建议卡本身的内容契约（4 条、标题、prompt）由本文件下方独立用例继续守着。
    expect(html).not.toContain('做个能玩的小游戏');
    expect(html).not.toContain('出一张可交互数据图表');
    expect(html).not.toContain('搜一份最新行业简报');
    expect(html).not.toContain('梳理磁盘空间占用');
    // 2026-08-01 起：这个夹具是**历史**会话（有标题、有消息计数），空态首屏不再给它
    // 通用欢迎页——冷启动自动恢复的历史会话此前与真新会话不可区分，用户以为自己新开
    // 了一条，首条消息接进了旧会话。会话标题因此获准出现在这一句消歧文案里；
    // 「会话操作不进聊天正文」的原意由本用例其余断言继续守着。
    expect(html).not.toContain('想完成什么？');
    expect(html).toContain('继续上次的会话：继续推进 Phase 5');
    // 批C2：tooltip 不再回显完整路径（内部路径泄漏面），上下文标签只读显示项目名
    // （2026-07-29：目录 chip 入口删除，目录选择收进侧栏「项目」区新建项目流程）。
    expect(html).toContain('项目会话 · code-agent');
    expect(html).not.toContain('welcome-directory-chip');
    expect(html).not.toContain('继承工作区：/repo/code-agent');
    expect(html).toContain('继承：工作区 · Browser · 最近工具 browser_action');
    expect(html).not.toContain('/repo/other');
  });

  it('does not fall back to stale app workspace for blank new sessions (and shows no context badge)', () => {
    const originalSessions = sessionState.sessions;
    sessionState.sessions = [{
      ...(originalSessions[0] as Record<string, unknown>),
      workingDirectory: undefined,
    }];

    try {
      const html = renderToStaticMarkup(React.createElement(ChatView));

      // 纯对话（默认形态）不再显示「空白会话」上下文标签——用户反馈看不懂、是噪音。
      expect(html).not.toContain('空白会话');
      // 关键：绝不能错误继承上一个项目/工作区的上下文。
      expect(html).not.toContain('继承：工作区 · Browser');
      expect(html).not.toContain('项目会话 · other');
      expect(html).not.toContain('/repo/other');
    } finally {
      sessionState.sessions = originalSessions;
    }
  });

  it('keeps starter prompts concrete enough for a first-turn deliverable', () => {
    expect(defaultSuggestions).toHaveLength(4);
    expect(defaultSuggestions.map((item) => item.title)).toEqual([
      '做个能玩的小游戏',
      '出一张可交互数据图表',
      '搜一份最新行业简报',
      '梳理磁盘空间占用',
    ]);

    for (const suggestion of defaultSuggestions) {
      expect(suggestion.prompt).not.toMatch(/如果|先问|先确认|和我对齐|补充信息|信息还不全/);
      expect(suggestion.prompt).toMatch(/做|渲染|搜索|找出|给出|输出|联网|列出/);
    }

    expect(defaultSuggestions[0].prompt).toContain('完整可运行的单文件');
    expect(defaultSuggestions[1].prompt).toContain('图表 JSON');
    expect(defaultSuggestions[2].prompt).toContain('过去一周 AI 行业');
    expect(defaultSuggestions[3].prompt).toContain('先列出，不要直接执行删除');
  });

  it('pending 提问时输入区仍可见可输入，发送继续走普通 ChatView 消息链路', async () => {
    sendMessageMock.mockClear();
    sessionState.pendingUserQuestionsBySessionId = new Map([[
      'session-1',
      [{
        id: 'question-pending',
        sessionId: 'session-1',
        timestamp: 1,
        questions: [{
          header: '方案',
          question: '选哪个？',
          options: [
            { label: 'A', description: 'a' },
            { label: 'B', description: 'b' },
          ],
        }],
      }],
    ]]);

    try {
      window.domainAPI = {
        invoke: vi.fn(async () => ({ success: true, data: null })),
      } as typeof window.domainAPI;
      render(React.createElement(ChatView));

      expect(screen.getByTestId('decision-slot')).toBeTruthy();
      expect(screen.getByTestId('user-question-card')).toBeTruthy();
      const input = screen.getByLabelText('chat-input-field');
      expect(input.closest('.hidden')).toBeNull();
      fireEvent.change(input, { target: { value: '先补一句上下文' } });
      expect((input as HTMLInputElement).value).toBe('先补一句上下文');
      fireEvent.submit(screen.getByTestId('chat-input'));

      await waitFor(() => {
        expect(sendMessageMock).toHaveBeenCalledWith(expect.objectContaining({
          content: '先补一句上下文',
        }));
      });
    } finally {
      cleanup();
      window.domainAPI = undefined;
      sessionState.pendingUserQuestionsBySessionId = new Map();
    }
  });

  it('跳过提问后只改输入区 placeholder，下一条普通消息发出后恢复', async () => {
    sendMessageMock.mockClear();
    ipcInvokeMock.mockClear();
    sessionState.pendingUserQuestionsBySessionId = new Map([[
      'session-1',
      [{
        id: 'question-skipped',
        sessionId: 'session-1',
        timestamp: 1,
        questions: [{
          header: '方案',
          question: '选哪个？',
          options: [
            { label: 'A', description: 'a' },
            { label: 'B', description: 'b' },
          ],
        }],
      }],
    ]]);

    try {
      window.domainAPI = {
        invoke: vi.fn(async () => ({ success: true, data: null })),
      } as typeof window.domainAPI;
      render(React.createElement(ChatView));
      fireEvent.click(screen.getByRole('button', { name: zh.userQuestion.skip }));

      const input = screen.getByLabelText('chat-input-field') as HTMLInputElement;
      await waitFor(() => expect(input.placeholder).toBe(zh.userQuestion.skippedPlaceholder));
      expect(screen.queryByTestId('user-question-card')).toBeNull();

      fireEvent.change(input, { target: { value: '按我刚补充的要求继续' } });
      fireEvent.submit(screen.getByTestId('chat-input'));
      await waitFor(() => expect(sendMessageMock).toHaveBeenCalledOnce());
      await waitFor(() => expect(input.placeholder).toBe(''));
    } finally {
      cleanup();
      window.domainAPI = undefined;
      sessionState.pendingUserQuestionsBySessionId = new Map();
    }
  });
});
