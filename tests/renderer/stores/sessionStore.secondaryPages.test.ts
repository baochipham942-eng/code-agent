// 二级页架构批 C（PR-C1）：二级页迁进右侧内容区后侧栏常驻可点，
// 「落到某个会话」必须让二级页让位——收在 switchSession / executeCreateSession
// 两个 chokepoint，而不是在 20+ 个调用点逐个抄。这里把这条契约钉死。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import type { Message, Session, TodoItem } from '../../../src/shared/contract';

const mockDomainInvoke = vi.fn();
const mockInvoke = vi.fn();

const OPEN_PAGES = {
  showCapabilityHub: true,
  showLibraryPanel: true,
  showCronCenter: true,
  showLocalOpsPanel: true,
  showEvalCenter: true,
  showProjectCollaborationPage: true,
  expertDetailRoleId: 'researcher',
} as const;

function readPageFlags() {
  const s = useAppStore.getState();
  return {
    showCapabilityHub: s.showCapabilityHub,
    showLibraryPanel: s.showLibraryPanel,
    showCronCenter: s.showCronCenter,
    showLocalOpsPanel: s.showLocalOpsPanel,
    showEvalCenter: s.showEvalCenter,
    showProjectCollaborationPage: s.showProjectCollaborationPage,
    expertDetailRoleId: s.expertDetailRoleId,
  };
}

const ALL_CLOSED = {
  showCapabilityHub: false,
  showLibraryPanel: false,
  showCronCenter: false,
  showLocalOpsPanel: false,
  showEvalCenter: false,
  showProjectCollaborationPage: false,
  expertDetailRoleId: null,
};

const persisted: Session & { messages: Message[]; todos: TodoItem[] } = {
  id: 'session-1',
  title: '历史会话',
  modelConfig: { provider: 'xiaomi', model: 'mimo-v2.5-pro', apiKey: '', maxTokens: 16384 },
  createdAt: 1,
  updatedAt: 2,
  messages: [],
  todos: [],
  status: 'completed',
};

describe('落到会话时二级页让位', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as Record<string, unknown>).window = {
      domainAPI: { invoke: mockDomainInvoke },
      electronAPI: { invoke: mockInvoke, on: vi.fn(() => () => {}), off: vi.fn() },
    };
    mockDomainInvoke.mockImplementation(async (domain: string, action: string) => {
      if (domain === IPC_DOMAINS.SESSION && action === 'load') return { success: true, data: persisted };
      if (domain === IPC_DOMAINS.SESSION && action === 'getSessionTasks') return { success: true, data: [] };
      if (domain === IPC_DOMAINS.SESSION && action === 'create') {
        return { success: true, data: { ...persisted, id: 'session-new', title: '新对话', status: 'idle' } };
      }
      return { success: false, error: { message: 'unexpected domain call' } };
    });
    mockInvoke.mockResolvedValue(null);
    useSessionStore.setState({
      sessions: [],
      currentSessionId: null,
      messages: [],
      todos: [],
      streamSnapshot: null,
      isLoading: false,
      error: null,
      unreadSessionIds: new Set<string>(),
      runningSessionIds: new Set<string>(),
      sessionRuntimes: new Map(),
      backgroundSessions: [],
      hasOlderMessages: false,
      isLoadingOlder: false,
      sessionDesignBriefs: new Map(),
    });
    useAppStore.setState({ ...OPEN_PAGES });
  });

  it('switchSession 关掉互斥表里全部二级页', async () => {
    await useSessionStore.getState().switchSession('session-1');
    expect(readPageFlags()).toEqual(ALL_CLOSED);
  });

  it('点当前会话（switchSession 早退分支）同样关二级页', async () => {
    useSessionStore.setState({ currentSessionId: 'session-1' });
    await useSessionStore.getState().switchSession('session-1');
    // 早退没走加载分支，但页必须已经让位——否则从二级页点当前会话回不去
    expect(mockDomainInvoke).not.toHaveBeenCalled();
    expect(readPageFlags()).toEqual(ALL_CLOSED);
  });

  it('新建会话关掉互斥表里全部二级页', async () => {
    await useSessionStore.getState().createSession('新会话', { workingDirectory: null });
    expect(readPageFlags()).toEqual(ALL_CLOSED);
  });
});
