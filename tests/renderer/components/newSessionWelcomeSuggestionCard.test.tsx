// @vitest-environment jsdom
// ============================================================================
// FB-580（2026-11-05 真机复现）：新会话欢迎页点示例卡 vs composer 里已有的草稿。
// 卡片本意是「不知道干什么」的一键起点；用户已经开始打字/挂附件/摆 chip 时，
// 点卡绝不替他发送（重活直接开跑）也不丢弃草稿——模板追加进输入框（空行分隔），
// 发送时机由用户决定。空 composer 保持一键直发。
//
// 三条验收（任务书 N-WELCOME-CARD-KEEP-DRAFT）：
//   1. 空 composer → 点卡发送一次；
//   2. 有文本 → 不发送，输入框里两段文本都在（空行分隔）；
//   3. 只有附件 → 不发送，附件保住。
// 场景 1-3 走真实组件组合：NewSessionWelcome + ChatInput 按 ChatView 的接法对插
// （isComposerOccupied/onFillDraft 都经 ChatInputHandle），分支与 handle 同一条链路。
// 用户「已打字」状态用 handle.setDraft 落进 composer——与回滚放回草稿同一条外部
// 写入通道（contenteditable 原生输入在 jsdom 里不可驱动）。
// ============================================================================

import React, { createRef } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

import { NewSessionWelcome, buildDefaultSuggestions } from '../../../src/renderer/components/features/chat/NewSessionWelcome';
import { ChatInput, type ChatInputHandle } from '../../../src/renderer/components/features/chat/ChatInput';
import { extractComposerPlainText, listChipMounts } from '../../../src/renderer/components/features/chat/ChatInput/composerRichTextModel';
import { zh } from '../../../src/renderer/i18n/zh';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import ipcService from '../../../src/renderer/services/ipcService';
import { useBundledCapabilityStore } from '../../../src/renderer/stores/bundledCapabilityStore';
import { useComposerStore } from '../../../src/renderer/stores/composerStore';
import { useSessionStore, type SessionWithMeta } from '../../../src/renderer/stores/sessionStore';
import type { MessageAttachment } from '../../../src/shared/contract/message';

const realCreateSession = useSessionStore.getState().createSession;

const suggestions = buildDefaultSuggestions(zh);
const WEEKLY_REPORT_PROMPT = suggestions[0].prompt;
const USER_TYPED = '我先记一下：本周要补两份数据';

const xlsxAttachment: MessageAttachment = {
  id: 'att-quarterly',
  type: 'file',
  category: 'excel',
  name: '季度销售数据.xlsx',
  size: 2048,
  mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function makeSession(id: string): SessionWithMeta {
  return {
    id,
    title: id,
    modelConfig: { provider: 'openai', model: 'gpt-5' },
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    turnCount: 0,
  } as SessionWithMeta;
}

function resetCapabilityStore(): void {
  useBundledCapabilityStore.setState({
    installed: { 'builtin.voice-live': false, 'builtin.voice-input': false },
    states: [],
    loaded: true,
    error: null,
  });
}

function showSession(session: SessionWithMeta): void {
  useSessionStore.setState({
    sessions: [session],
    currentSessionId: session.id,
    messages: [],
    createSession: realCreateSession,
  });
}

// 与 ChatView 的接线同款：占用探针与填充都走 ChatInputHandle。
function WelcomeFlowHarness({
  onSend,
  chatInputRef,
}: {
  onSend: (message: string) => void;
  chatInputRef: React.RefObject<ChatInputHandle | null>;
}) {
  return (
    <div>
      <NewSessionWelcome
        onSend={onSend}
        isComposerOccupied={() => Boolean(chatInputRef.current?.hasDraftOccupancy())}
        onFillDraft={(prompt) => chatInputRef.current?.appendDraftPrompt(prompt)}
      />
      <ChatInput ref={chatInputRef} onSend={vi.fn(async () => true)} />
    </div>
  );
}

function getEditor(): HTMLElement {
  return screen.getByTestId('chat-composer-textarea');
}

function clickWeeklyReportCard(): void {
  fireEvent.click(screen.getByText(suggestions[0].title));
}

beforeEach(() => {
  resetCapabilityStore();
  const invokeDomain = ipcService.invokeDomain.bind(ipcService);
  vi.spyOn(ipcService, 'invokeDomain').mockImplementation((domain, action, payload) => {
    if (domain === IPC_DOMAINS.QUEUED_INPUT && action === 'list') return Promise.resolve([]);
    return invokeDomain(domain, action, payload);
  });
  showSession(makeSession('session-fb580'));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useSessionStore.setState({
    sessions: [],
    currentSessionId: null,
    messages: [],
    createSession: realCreateSession,
  });
  useComposerStore.setState({ pendingCommand: null, selectedSkillIds: [] });
  resetCapabilityStore();
});

describe('FB-580 示例卡 × composer 草稿保育（真实组件组合）', () => {
  it('空 composer：点卡一键直发，且只发一次', () => {
    const onSend = vi.fn();
    const chatInputRef = createRef<ChatInputHandle>();
    render(<WelcomeFlowHarness onSend={onSend} chatInputRef={chatInputRef} />);

    expect(chatInputRef.current?.hasDraftOccupancy()).toBe(false);
    clickWeeklyReportCard();

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith(WEEKLY_REPORT_PROMPT);
    // 没走填充分支：输入框仍是空的
    expect(extractComposerPlainText(getEditor())).toBe('');
  });

  it('纯空白草稿不算占用：仍走一键直发，不被空白字符「占住」', () => {
    const onSend = vi.fn();
    const chatInputRef = createRef<ChatInputHandle>();
    render(<WelcomeFlowHarness onSend={onSend} chatInputRef={chatInputRef} />);

    act(() => {
      chatInputRef.current?.setDraft({ content: '   \n\t' });
    });
    expect(chatInputRef.current?.hasDraftOccupancy()).toBe(false);
    clickWeeklyReportCard();

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith(WEEKLY_REPORT_PROMPT);
  });

  it('composer 已有文本：不发送，模板空行接在用户文本之后，输入框获得焦点', () => {
    const onSend = vi.fn();
    const chatInputRef = createRef<ChatInputHandle>();
    render(<WelcomeFlowHarness onSend={onSend} chatInputRef={chatInputRef} />);

    act(() => {
      chatInputRef.current?.setDraft({ content: USER_TYPED });
    });
    expect(chatInputRef.current?.hasDraftOccupancy()).toBe(true);
    // setDraft 自带聚焦；先失焦，焦点断言才只属于点卡后的填充动作
    act(() => {
      (document.activeElement as HTMLElement | null)?.blur();
    });
    expect(document.activeElement).not.toBe(getEditor());

    clickWeeklyReportCard();

    expect(onSend).not.toHaveBeenCalled();
    const text = extractComposerPlainText(getEditor());
    expect(text).toBe(`${USER_TYPED}\n\n${WEEKLY_REPORT_PROMPT}`);
    // 两段文本都在，且中间空了一行
    expect(text).toContain(USER_TYPED);
    expect(text).toContain(WEEKLY_REPORT_PROMPT);
    expect(document.activeElement).toBe(getEditor());
  });

  it('已有文本带尾随空白：追加前先收尾，不叠出三行空行', () => {
    const onSend = vi.fn();
    const chatInputRef = createRef<ChatInputHandle>();
    render(<WelcomeFlowHarness onSend={onSend} chatInputRef={chatInputRef} />);

    act(() => {
      chatInputRef.current?.setDraft({ content: `${USER_TYPED}\n  ` });
    });
    clickWeeklyReportCard();

    expect(onSend).not.toHaveBeenCalled();
    expect(extractComposerPlainText(getEditor())).toBe(`${USER_TYPED}\n\n${WEEKLY_REPORT_PROMPT}`);
  });

  it('composer 只有附件：不发送，附件保住，模板进输入框', () => {
    const onSend = vi.fn();
    const chatInputRef = createRef<ChatInputHandle>();
    render(<WelcomeFlowHarness onSend={onSend} chatInputRef={chatInputRef} />);

    act(() => {
      chatInputRef.current?.addAttachments([xlsxAttachment]);
    });
    // 附件在输入区里就是内联 chip（file:*），纯文本仍为空——正是「只挂了附件」的形状
    expect(chatInputRef.current?.hasDraftOccupancy()).toBe(true);

    clickWeeklyReportCard();

    expect(onSend).not.toHaveBeenCalled();
    const editor = getEditor();
    const chipKeys = listChipMounts(editor).map((mount) => mount.getAttribute('data-composer-chip-key'));
    expect(chipKeys).toContain('file:att-quarterly');
    // 空文本基底：追加语义就是模板本身
    expect(extractComposerPlainText(editor)).toBe(WEEKLY_REPORT_PROMPT);
  });
});
