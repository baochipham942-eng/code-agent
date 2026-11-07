// @vitest-environment jsdom
// ============================================================================
// 专家（角色绑定）会话的空态欢迎页（N-ROLE-EMPTY-SESSION-WELCOME-COPY）：
// 专家主 thread 的标题是角色名而非「新对话」，isBlankNewSession 恒 false，空态首屏
// 落进「继续上次的会话：{角色名}」+「这条会话还没有内容」——对刚建好的专家 thread
// 自相矛盾，四张通用职场模板卡也与这位专家无关。
//
// 验收：
//   1. 专家空会话标题 = 专家名，副标题 = 新键文案，绝不出现「继续上次的会话 /
//      这条会话还没有内容」；
//   2. 角色没有既有建议时一张卡都不摆（绝不回退通用卡）；
//   3. 有既有建议（醒来提议 + 快捷开场 prompt，均取自角色数据原话）时最多四张，
//      醒来提议优先；
//   4. 非角色空会话保持原行为（欢迎页 + 通用卡、「继续上次的会话」原样）；
//   5. 角色卡同一键行为：空 composer 一键直发，composer 有字改填草稿（FB-580 同款）。
// 判定依据与 RoleFirstWakeThreadBanner 同源（resolveBannerRoleId），不另立字段。
// ============================================================================

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoleFirstWakeSnapshot, RolePanelEntry } from '../../../src/shared/contract/roleAssets';

const listRoles = vi.fn<() => Promise<RolePanelEntry[]>>();
const listWakeProposals = vi.fn<(roleId: string) => Promise<Array<{ title: string; prompt: string }>>>();
const acceptWakeProposal = vi.fn<(roleId: string, title: string) => Promise<{ prompt: string } | null>>();
const dismissWakeProposal = vi.fn<(roleId: string, title: string) => Promise<{ success: boolean }>>();
const getFirstWake = vi.fn<(roleId: string) => Promise<RoleFirstWakeSnapshot | null>>();

vi.mock('../../../src/renderer/services/rolesClient', () => ({
  listRoles: () => listRoles(),
  listWakeProposals: (roleId: string) => listWakeProposals(roleId),
  acceptWakeProposal: (roleId: string, title: string) => acceptWakeProposal(roleId, title),
  dismissWakeProposal: (roleId: string, title: string) => dismissWakeProposal(roleId, title),
  getFirstWake: (roleId: string) => getFirstWake(roleId),
  skipFirstWake: vi.fn(async () => ({ success: true })),
  retryFirstWake: vi.fn(async () => ({ retried: false })),
}));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

import { NewSessionWelcome } from '../../../src/renderer/components/features/chat/NewSessionWelcome';
import { RoleFirstWakeThreadBanner } from '../../../src/renderer/components/features/chat/RoleFirstWakeCard';
import { zh } from '../../../src/renderer/i18n/zh';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore, type SessionWithMeta } from '../../../src/renderer/stores/sessionStore';

const WELCOME_TITLE = zh.chat.welcomeTitle;
const EXPERT_SUBTITLE = zh.chat.expertEmptySubtitle;
const GENERIC_CARD_TITLE = zh.chat.suggestions.weeklyReport.title;

function session(overrides: Partial<SessionWithMeta>): SessionWithMeta {
  return {
    id: 'session-role-1',
    title: 'role-1',
    modelConfig: { provider: 'openai', model: 'gpt-5.4' },
    createdAt: 1,
    updatedAt: Date.now() - 9 * 60 * 60 * 1000,
    messageCount: 0,
    turnCount: 0,
    ...overrides,
  } as SessionWithMeta;
}

// 与宿主落盘同形：sessions.metadata.expertThread = { roleId, setAt }
function expertThreadSession(overrides: Partial<SessionWithMeta> = {}): SessionWithMeta {
  return session({
    metadata: { expertThread: { roleId: 'role-1', setAt: 1_700_000_000_000 } },
    ...overrides,
  });
}

const ROLE: RolePanelEntry = {
  roleId: 'role-1',
  description: '',
  source: 'user',
  memoryCount: 0,
  lastWork: null,
  displayName: '小满',
};

beforeEach(() => {
  vi.resetAllMocks();
  getFirstWake.mockResolvedValue({ state: 'skipped', sourcesMode: 'connected', suggestions: [] });
  dismissWakeProposal.mockResolvedValue({ success: true });
  useAppStore.setState({ firstWakeCardRoleId: null });
  useSessionStore.setState({ currentSessionId: null, sessions: [] });
});

afterEach(() => {
  cleanup();
  useAppStore.setState({ firstWakeCardRoleId: null });
  useSessionStore.setState({ currentSessionId: null, sessions: [] });
});

describe('专家空会话：标题写专家名，不再说「继续上次的会话」', () => {
  it('标题 = displayName，副标题 = 新键文案；矛盾文案与通用卡都不出现', async () => {
    listRoles.mockResolvedValue([ROLE]);
    listWakeProposals.mockResolvedValue([]);

    render(<NewSessionWelcome onSend={vi.fn()} session={expertThreadSession()} />);

    await waitFor(() => {
      expect(screen.getByTestId('chat-welcome-title').textContent).toBe('小满');
    });
    expect(screen.getByText(EXPERT_SUBTITLE)).toBeTruthy();
    expect(screen.getByTestId('chat-welcome-title').textContent).not.toContain('继续上次的会话');
    expect(screen.queryByText(/这条会话还没有内容/)).toBeNull();
    // 通用职场模板卡与这位专家无关：不摆
    expect(screen.queryByText(GENERIC_CARD_TITLE)).toBeNull();
  });

  it('listRoles 拿不到展示名时回退 roleId（同 RoleFirstWakeCard 的兜底）', async () => {
    listRoles.mockResolvedValue([]);
    listWakeProposals.mockResolvedValue([]);

    render(<NewSessionWelcome onSend={vi.fn()} session={expertThreadSession()} />);

    await waitFor(() => {
      expect(screen.getByTestId('chat-welcome-title').textContent).toBe('role-1');
    });
    expect(screen.getByText(EXPERT_SUBTITLE)).toBeTruthy();
  });

  it('roles IPC 失败：标题保底 roleId，副标题仍在，不摆卡', async () => {
    listRoles.mockRejectedValue(new Error('ipc down'));
    listWakeProposals.mockRejectedValue(new Error('ipc down'));

    render(<NewSessionWelcome onSend={vi.fn()} session={expertThreadSession()} />);

    await waitFor(() => {
      expect(screen.getByTestId('chat-welcome-title').textContent).toBe('role-1');
    });
    expect(screen.getByText(EXPERT_SUBTITLE)).toBeTruthy();
    expect(screen.queryByText(GENERIC_CARD_TITLE)).toBeNull();
  });

  it('first_wake origin（无 expertThread 标记）同样认出专家——与顶部横幅同源判定', async () => {
    listRoles.mockResolvedValue([ROLE]);
    listWakeProposals.mockResolvedValue([]);

    render(
      <NewSessionWelcome
        onSend={vi.fn()}
        session={session({
          origin: { kind: 'cron', metadata: { trigger: 'first_wake', roleId: 'role-1' } },
        })}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('chat-welcome-title').textContent).toBe('小满');
    });
    expect(screen.getByText(EXPERT_SUBTITLE)).toBeTruthy();
  });
});

describe('专家空会话的起手卡：只摆角色既有数据，最多四张', () => {
  it('welcome 已展示 wake proposal 时顶部 banner 不重复渲染', async () => {
    listRoles.mockResolvedValue([ROLE]);
    listWakeProposals.mockResolvedValue([{ title: '提议甲', prompt: '提议甲的委托' }]);
    useSessionStore.setState({
      currentSessionId: 'session-role-1',
      sessions: [expertThreadSession()] as never,
    });

    render(
      <>
        <RoleFirstWakeThreadBanner suppressWakeProposals />
        <NewSessionWelcome onSend={vi.fn()} session={expertThreadSession()} />
      </>,
    );

    await waitFor(() => expect(screen.getAllByText('提议甲')).toHaveLength(1));
    expect(screen.queryByTestId('role-wake-proposals-card')).toBeNull();
  });

  it('醒来提议 + 快捷开场 prompt 超过四条时只摆四张，醒来提议优先', async () => {
    listRoles.mockResolvedValue([
      {
        ...ROLE,
        quickPrompts: ['开场一', '开场二', '开场三'],
      },
    ]);
    listWakeProposals.mockResolvedValue([
      { title: '提议甲', prompt: '提议甲的委托' },
      { title: '提议乙', prompt: '提议乙的委托' },
      { title: '提议丙', prompt: '提议丙的委托' },
    ]);

    render(<NewSessionWelcome onSend={vi.fn()} session={expertThreadSession()} />);

    await waitFor(() => {
      expect(screen.getByText('提议甲')).toBeTruthy();
    });
    expect(screen.getByText('提议乙')).toBeTruthy();
    expect(screen.getByText('提议丙')).toBeTruthy();
    expect(screen.getByText('开场一')).toBeTruthy();
    // 3 提议 + 1 开场 = 4 张封顶，其余开场不出现
    expect(screen.queryByText('开场二')).toBeNull();
    expect(screen.queryByText('开场三')).toBeNull();
  });

  it('只有快捷开场 prompt 时原话上卡（不在代码里编造角色专属 prompt）', async () => {
    listRoles.mockResolvedValue([
      { ...ROLE, quickPrompts: ['帮我分析这份表格，找出关键指标和异常点'] },
    ]);
    listWakeProposals.mockResolvedValue([]);

    render(<NewSessionWelcome onSend={vi.fn()} session={expertThreadSession()} />);

    await waitFor(() => {
      expect(screen.getByText('帮我分析这份表格，找出关键指标和异常点')).toBeTruthy();
    });
    expect(screen.queryByText(GENERIC_CARD_TITLE)).toBeNull();
  });

  it('角色没有任何既有建议：一张卡都不摆（绝不回退通用卡）', async () => {
    listRoles.mockResolvedValue([ROLE]);
    listWakeProposals.mockResolvedValue([]);

    render(<NewSessionWelcome onSend={vi.fn()} session={expertThreadSession()} />);

    await waitFor(() => {
      expect(screen.getByTestId('chat-welcome-title').textContent).toBe('小满');
    });
    expect(screen.queryByText(GENERIC_CARD_TITLE)).toBeNull();
    expect(screen.queryByText(zh.chat.suggestions.meetingNotes.title)).toBeNull();
    expect(screen.queryByText(zh.chat.suggestions.sheetAnalysis.title)).toBeNull();
    expect(screen.queryByText(zh.chat.suggestions.competitorBrief.title)).toBeNull();
  });

  it('角色卡同一键行为：空 composer 点卡直发该角色的 prompt', async () => {
    listRoles.mockResolvedValue([{ ...ROLE, quickPrompts: ['帮我把这份资料读一遍'] }]);
    listWakeProposals.mockResolvedValue([]);
    const onSend = vi.fn();

    render(<NewSessionWelcome onSend={onSend} session={expertThreadSession()} />);
    fireEvent.click(await screen.findByText('帮我把这份资料读一遍'));

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('帮我把这份资料读一遍');
  });

  it('wake proposal 卡先调 acceptWakeProposal 消费，再发送 host 返回的 prompt', async () => {
    listRoles.mockResolvedValue([ROLE]);
    listWakeProposals.mockResolvedValue([{ title: '提议甲', prompt: '旧的本地 prompt' }]);
    acceptWakeProposal.mockResolvedValue({ prompt: 'host 接受后返回的 prompt' });
    const onSend = vi.fn();

    render(<NewSessionWelcome onSend={onSend} session={expertThreadSession()} />);
    fireEvent.click(await screen.findByText('提议甲'));

    await waitFor(() => expect(acceptWakeProposal).toHaveBeenCalledWith('role-1', '提议甲'));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('host 接受后返回的 prompt'));
    expect(screen.queryByText('提议甲')).toBeNull();
  });

  it('角色卡同 FB-580：composer 有字时不发送、改填草稿', async () => {
    listRoles.mockResolvedValue([{ ...ROLE, quickPrompts: ['帮我把这份资料读一遍'] }]);
    listWakeProposals.mockResolvedValue([]);
    const onSend = vi.fn();
    const onFillDraft = vi.fn();
    const occupied = vi.fn(() => true);

    render(
      <NewSessionWelcome
        onSend={onSend}
        isComposerOccupied={occupied}
        onFillDraft={onFillDraft}
        session={expertThreadSession()}
      />,
    );
    fireEvent.click(await screen.findByText('帮我把这份资料读一遍'));

    expect(onSend).not.toHaveBeenCalled();
    expect(onFillDraft).toHaveBeenCalledTimes(1);
    expect(onFillDraft).toHaveBeenCalledWith('帮我把这份资料读一遍');
  });
});

describe('非角色空会话：行为原样保留', () => {
  it('真·新会话仍是欢迎页 + 通用建议卡', () => {
    render(<NewSessionWelcome onSend={vi.fn()} session={session({ title: '新对话' })} />);

    expect(screen.getByTestId('chat-welcome-title').textContent).toBe(WELCOME_TITLE);
    expect(screen.getByText(GENERIC_CARD_TITLE)).toBeTruthy();
    // 没有角色绑定就不该发起 roles IPC
    expect(listRoles).not.toHaveBeenCalled();
    expect(listWakeProposals).not.toHaveBeenCalled();
  });

  it('恢复的空历史会话仍显示「继续上次的会话」（2026-08-01 消歧不回退）', () => {
    render(<NewSessionWelcome onSend={vi.fn()} session={session({ title: '你好' })} />);

    const title = screen.getByTestId('chat-welcome-title').textContent ?? '';
    expect(title).toContain('你好');
    expect(title).toContain('继续上次的会话');
    expect(screen.getByText(/新任务/)).toBeTruthy();
    expect(listRoles).not.toHaveBeenCalled();
  });
});

// 引用完整性：resolveBannerRoleId 必须仍是与横幅同源的那份判定（防止有人复制一份私有实现）。
describe('专家判定与 RoleFirstWakeThreadBanner 同源', () => {
  it('NewSessionWelcome 走的 resolveBannerRoleId 与横幅导出是同一函数', async () => {
    const bannerModule = await import('../../../src/renderer/components/features/chat/RoleFirstWakeCard');
    expect(typeof bannerModule.resolveBannerRoleId).toBe('function');
    expect(
      bannerModule.resolveBannerRoleId({ metadata: { expertThread: { roleId: 'r', setAt: 1 } } }),
    ).toBe('r');
    expect(
      bannerModule.resolveBannerRoleId({ origin: { kind: 'cron', metadata: { trigger: 'first_wake', roleId: 'r2' } } }),
    ).toBe('r2');
    expect(bannerModule.resolveBannerRoleId({ origin: { kind: 'manual' } })).toBeUndefined();
  });
});
