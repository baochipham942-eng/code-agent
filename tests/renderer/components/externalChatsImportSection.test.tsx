// @vitest-environment jsdom
// ============================================================================
// ExternalChatsImportSection 组件测试（N-EXTHISTORY-IMPORT-CHATS-HOST-FU1）
// ============================================================================
//
// 「从其他 AI 应用导入」页的最近聊天一键导入卡：
// - 点击 → agentEngine 域 importRecentChats action，汇总行 + 逐条行（标题 · 引擎名 · 状态大白话）
// - 第二次点击全部 already_imported：汇总与行都改口「已在 Neo」
// - 零候选 → 空态文案一行，绝不出空白
// - 裸 reason 串与源路径不出现在 DOM；IPC 失败只给固定文案
// - en 文案齐备（engineNames/statusLabels 双语）

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { RecentExternalChatImportResult } from '../../../src/shared/contract/agentEngine';
import { IPC_DOMAINS } from '../../../src/shared/ipc/domains';

const invokeDomain = vi.hoisted(() => vi.fn());
// 「保持聊天同步」的两个 action 走独立 mock，避免干扰 importRecentChats 的按序返回值。
const syncInvoke = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    isAvailable: () => false,
    invoke: vi.fn(),
    invokeDomain: (...args: unknown[]) => (
      args[1] === 'getChatsSync' || args[1] === 'setChatsSync'
        ? syncInvoke(args[1], args[2])
        : invokeDomain(...args)
    ),
    on: () => () => {},
    off: vi.fn(),
  },
}));

import { ExternalChatsImportSection } from '../../../src/renderer/components/features/settings/tabs/ExternalChatsImportSection';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';

const FIRST_RUN: RecentExternalChatImportResult[] = [
  { engine: 'claude_code', sourceSessionId: 's-1', title: '重构计划', status: 'imported' },
  { engine: 'codex_cli', sourceSessionId: 's-2', title: '旧项目问答', status: 'already_imported' },
  {
    engine: 'claude_code',
    sourceSessionId: 's-3',
    title: '目录没了的会话',
    status: 'folder_missing',
    reason: 'workspace directory is not on disk: /Users/fixture/gone',
  },
  {
    engine: 'codex_cli',
    sourceSessionId: 's-4',
    title: '坏掉的一条',
    status: 'failed',
    reason: 'PARSE_ERROR: /Users/fixture/.claude/projects/bad.jsonl',
  },
];

const SECOND_RUN: RecentExternalChatImportResult[] = FIRST_RUN.map((item) => ({
  ...item,
  status: 'already_imported' as const,
}));

beforeEach(() => {
  invokeDomain.mockReset();
  syncInvoke.mockReset();
  syncInvoke.mockResolvedValue({ mode: 'off' });
  useAppStore.setState({ language: 'zh' });
});

afterEach(cleanup);

describe('ExternalChatsImportSection 点击与结果（验收②③ UI 半）', () => {
  it('点击调用 agentEngine 域 importRecentChats，汇总行 + 逐条行给大白话；裸 reason 与路径不进 DOM', async () => {
    invokeDomain.mockResolvedValue(FIRST_RUN);
    render(<ExternalChatsImportSection />);

    expect(screen.getByTestId('external-chats-import').textContent).toContain('最近聊天');
    expect(screen.getByTestId('external-chats-import').textContent)
      .toContain('最近 30 天的 Claude Code / Codex CLI 聊天');

    fireEvent.click(screen.getByText('导入最近的聊天'));
    await screen.findByTestId('external-chats-import-results');

    expect(invokeDomain).toHaveBeenCalledWith(IPC_DOMAINS.AGENT_ENGINE, 'importRecentChats');
    expect(screen.getByTestId('external-chats-import-summary').textContent)
      .toBe('已导入 1 · 已在 Neo 1 · 目录不存在 1 · 失败 1');
    expect(screen.getByTestId('external-chats-import-row-s-1').textContent).toBe('重构计划 · Claude Code · 已导入');
    expect(screen.getByTestId('external-chats-import-row-s-2').textContent).toBe('旧项目问答 · Codex · 已在 Neo');
    expect(screen.getByTestId('external-chats-import-row-s-3').textContent)
      .toBe('目录没了的会话 · Claude Code · 原目录已不存在，恢复目录后重新点击即可导入');
    expect(screen.getByTestId('external-chats-import-row-s-4').textContent).toBe('坏掉的一条 · Codex · 这一条没能导入');

    // 裸 reason 串、源路径、裸引擎 id 都不出现（status/engine 只走 i18n 标签）
    const dom = document.body.textContent ?? '';
    expect(dom).not.toContain('/Users/fixture');
    expect(dom).not.toContain('PARSE_ERROR');
    expect(dom).not.toContain('workspace directory');
    expect(dom).not.toContain('claude_code');
    expect(dom).not.toContain('codex_cli');
    expect(dom).not.toContain('folder_missing');
  });

  it('第二次点击全部 already_imported：汇总与每行都改口「已在 Neo」', async () => {
    invokeDomain.mockResolvedValueOnce(FIRST_RUN).mockResolvedValueOnce(SECOND_RUN);
    render(<ExternalChatsImportSection />);

    fireEvent.click(screen.getByText('导入最近的聊天'));
    await screen.findByTestId('external-chats-import-summary');
    expect(screen.getByTestId('external-chats-import-summary').textContent)
      .toBe('已导入 1 · 已在 Neo 1 · 目录不存在 1 · 失败 1');

    fireEvent.click(screen.getByText('导入最近的聊天'));
    await waitFor(() => {
      expect(screen.getByTestId('external-chats-import-summary').textContent)
        .toBe('已导入 0 · 已在 Neo 4 · 目录不存在 0 · 失败 0');
    });
    for (const row of ['s-1', 's-2', 's-3', 's-4']) {
      expect(screen.getByTestId(`external-chats-import-row-${row}`).textContent)
        .toContain('已在 Neo');
    }
  });

  it('零候选 → 空态文案一行，绝不出空白', async () => {
    invokeDomain.mockResolvedValue([]);
    render(<ExternalChatsImportSection />);

    fireEvent.click(screen.getByText('导入最近的聊天'));
    await screen.findByTestId('external-chats-import-empty');

    expect(screen.getByTestId('external-chats-import-empty').textContent)
      .toBe('最近 30 天没有发现 Claude Code 或 Codex 聊天');
  });

  it('IPC 失败 → 固定文案，不带原始错误串', async () => {
    invokeDomain.mockRejectedValue(new Error('INTERNAL_ERROR: /Users/fixture/.claude/projects/x.jsonl'));
    render(<ExternalChatsImportSection />);

    fireEvent.click(screen.getByText('导入最近的聊天'));
    await screen.findByTestId('external-chats-import-error');

    expect(screen.getByTestId('external-chats-import-error').textContent).toBe('导入最近的聊天失败');
    expect(screen.queryByTestId('external-chats-import-results')).toBeNull();
    expect(document.body.textContent ?? '').not.toContain('/Users/fixture');
  });

  it('en 文案齐备：汇总与状态标签走英文', async () => {
    useAppStore.setState({ language: 'en' });
    invokeDomain.mockResolvedValue(FIRST_RUN);
    render(<ExternalChatsImportSection />);

    fireEvent.click(screen.getByText('Import recent chats'));
    await screen.findByTestId('external-chats-import-summary');

    expect(screen.getByTestId('external-chats-import-summary').textContent)
      .toBe('Imported 1 · already in Neo 1 · folder not found 1 · failed 1');
    expect(screen.getByTestId('external-chats-import-row-s-3').textContent)
      .toBe('目录没了的会话 · Claude Code · The original folder is gone; restore it and click again to import');
    expect(screen.getByTestId('external-chats-import-row-s-4').textContent)
      .toBe('坏掉的一条 · Codex · Could not import this one');
  });
});

// ============================================================================
// 导入成功后即时刷新会话列表（N-EXTHISTORY-IMPORT-CHATS-HOST-FU1-FU1-FU2）
// ============================================================================
//
// 只在 imported > 0 时 loadSessions({ silent: true })（与 sessionStoreBroadcasts
// 的静默刷新同款）；全部 already_imported / 零候选 / IPC 失败不刷；刷新被拒
// 不翻错误态、结果照常显示。spy 挂在真 store 的 action 槽位上。
describe('导入成功后刷新 session store（FU1-FU2）', () => {
  let loadSessionsSpy: ReturnType<typeof vi.fn>;
  let originalLoadSessions: unknown;

  beforeEach(() => {
    originalLoadSessions = useSessionStore.getState().loadSessions;
    loadSessionsSpy = vi.fn().mockResolvedValue(undefined);
    useSessionStore.setState({ loadSessions: loadSessionsSpy as never });
  });

  afterEach(() => {
    useSessionStore.setState({ loadSessions: originalLoadSessions as never });
  });

  it('imported>0 的首轮 → loadSessions 恰好一次且带 { silent: true }，结果照常显示', async () => {
    invokeDomain.mockResolvedValue(FIRST_RUN);
    render(<ExternalChatsImportSection />);
    fireEvent.click(screen.getByText('导入最近的聊天'));
    await screen.findByTestId('external-chats-import-summary');

    expect(loadSessionsSpy).toHaveBeenCalledTimes(1);
    expect(loadSessionsSpy).toHaveBeenCalledWith({ silent: true });
  });

  it('全部 already_imported 的第二轮 → 不刷', async () => {
    invokeDomain.mockResolvedValueOnce(FIRST_RUN).mockResolvedValueOnce(SECOND_RUN);
    render(<ExternalChatsImportSection />);
    fireEvent.click(screen.getByText('导入最近的聊天'));
    await screen.findByTestId('external-chats-import-summary');
    expect(loadSessionsSpy).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText('导入最近的聊天'));
    await waitFor(() => {
      expect(screen.getByTestId('external-chats-import-summary').textContent)
        .toBe('已导入 0 · 已在 Neo 4 · 目录不存在 0 · 失败 0');
    });
    expect(loadSessionsSpy).toHaveBeenCalledTimes(1);
  });

  it('零候选 → 不刷', async () => {
    invokeDomain.mockResolvedValue([]);
    render(<ExternalChatsImportSection />);
    fireEvent.click(screen.getByText('导入最近的聊天'));
    await screen.findByTestId('external-chats-import-empty');
    expect(loadSessionsSpy).not.toHaveBeenCalled();
  });

  it('IPC 失败 → 不刷且错误态照旧', async () => {
    invokeDomain.mockRejectedValue(new Error('INTERNAL_ERROR'));
    render(<ExternalChatsImportSection />);
    fireEvent.click(screen.getByText('导入最近的聊天'));
    await screen.findByTestId('external-chats-import-error');
    expect(loadSessionsSpy).not.toHaveBeenCalled();
  });

  it('loadSessions 被拒 → 汇总仍在、错误横幅不出现', async () => {
    loadSessionsSpy.mockRejectedValue(new Error('refresh blew up'));
    invokeDomain.mockResolvedValue(FIRST_RUN);
    render(<ExternalChatsImportSection />);
    fireEvent.click(screen.getByText('导入最近的聊天'));
    await screen.findByTestId('external-chats-import-summary');

    expect(screen.getByTestId('external-chats-import-summary').textContent)
      .toBe('已导入 1 · 已在 Neo 1 · 目录不存在 1 · 失败 1');
    expect(screen.queryByTestId('external-chats-import-error')).toBeNull();
  });
});

// ============================================================================
// 「保持聊天同步」三态（N-EXTHISTORY-IMPORT-SYNC-CHATS）
// ============================================================================
describe('保持聊天同步 三态', () => {
  const dump = () => screen.getByTestId('external-chats-sync').textContent ?? '';

  it('off：开关关闭、状态「未开启」、无暂停按钮；打开开关 → setChatsSync on，展示刚同步与新增数', async () => {
    syncInvoke.mockImplementation(async (action: string, payload?: { mode: string }) =>
      action === 'setChatsSync'
        ? { mode: payload?.mode, lastRun: { at: Date.now(), imported: 3 } }
        : { mode: 'off' });
    render(<ExternalChatsImportSection />);
    await waitFor(() => expect(syncInvoke).toHaveBeenCalledWith('getChatsSync', undefined));
    expect(screen.getByTestId('external-chats-sync-status').textContent).toBe('未开启');
    expect(screen.queryByText('暂停同步')).toBeNull();
    const toggle = screen.getByRole('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByTestId('external-chats-sync-status').textContent).toContain('新增 3 条'));
    expect(syncInvoke).toHaveBeenCalledWith('setChatsSync', { mode: 'on' });
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('暂停同步')).toBeTruthy();
  });

  it('on → 暂停 → paused：状态「已暂停，已导入的聊天保留」，按钮变「恢复同步」', async () => {
    syncInvoke.mockImplementation(async (action: string, payload?: { mode: string }) =>
      action === 'setChatsSync' ? { mode: payload?.mode } : { mode: 'on' });
    render(<ExternalChatsImportSection />);
    fireEvent.click(await screen.findByText('暂停同步'));
    await waitFor(() => expect(screen.getByTestId('external-chats-sync-status').textContent)
      .toBe('已暂停，已导入的聊天保留'));
    expect(syncInvoke).toHaveBeenCalledWith('setChatsSync', { mode: 'paused' });
    expect(screen.getByText('恢复同步')).toBeTruthy();
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
    expect(dump()).not.toContain('paused');
  });

  it('setChatsSync 失败 → 固定文案', async () => {
    syncInvoke.mockImplementation(async (action: string) => {
      if (action === 'setChatsSync') throw new Error('INTERNAL: /Users/x');
      return { mode: 'off' };
    });
    render(<ExternalChatsImportSection />);
    fireEvent.click(screen.getByRole('switch'));
    await screen.findByTestId('external-chats-sync-error');
    expect(document.body.textContent ?? '').not.toContain('/Users/x');
  });
});
