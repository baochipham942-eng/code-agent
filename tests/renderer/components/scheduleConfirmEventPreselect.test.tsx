// @vitest-environment jsdom
// ============================================================================
// N-CRON-EVENT-CONFIRM-PRESELECT：/schedule 群监听确认卡自动预选账号与群，
// 且从不静默退化成「任意会话」。fixtures 用真实 ChannelAccount / 会话目录形状，
// 经真实 useChannelCatalog（只 mock ipcService 边界）。
// ============================================================================
import React, { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelAccount } from '../../../src/shared/contract/channel';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import { cronCenterZh } from '../../../src/renderer/i18n/cronCenter';

const ipc = vi.hoisted(() => ({
  invoke: vi.fn(),
  on: vi.fn(() => () => undefined),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({ default: ipc }));

import { ScheduleConfirmCard } from '../../../src/renderer/components/features/chat/ChatInput/ScheduleConfirmCard';
import { CronEventScheduleFields } from '../../../src/renderer/components/features/cron/CronEventScheduleFields';
import type { PendingScheduleDraft } from '../../../src/renderer/components/features/chat/ChatInput/useScheduleDraft';
import type { CreateCronJobInput } from '../../../src/renderer/services/cronClient';

const cc = cronCenterZh.cronCenter;

function account(id: string, name: string): ChannelAccount {
  return {
    id,
    name,
    type: 'feishu',
    config: { type: 'feishu', appId: `${id}-app`, appSecret: 'secret' },
    status: 'connected',
    enabled: true,
    createdAt: 1,
  };
}
const workA = account('acc-a', '工作飞书');
const workB = account('acc-b', '个人飞书');

type Catalog = Record<string, { id: string; name: string }[]>;
function mockCatalog(accounts: ChannelAccount[], catalog: Catalog): void {
  ipc.invoke.mockImplementation(async (channel: string, accountId?: string) => {
    if (channel === IPC_CHANNELS.CHANNEL_LIST_ACCOUNTS) return accounts;
    if (channel === IPC_CHANNELS.CHANNEL_LIST_CONVERSATIONS) {
      return { supported: true, conversations: catalog[accountId ?? ''] ?? [] };
    }
    return undefined;
  });
}

function makeDraft(draftId: number, groupName?: string): PendingScheduleDraft {
  return {
    draftId,
    input: {
      name: '群监听',
      description: '监听群消息',
      enabled: true,
      scheduleType: 'event',
      schedule: { type: 'event', source: 'channel', eventName: 'message' },
      action: { type: 'agent', agentType: 'default', prompt: '总结群消息' },
      runsOn: 'local',
      maxRunBudget: 0.5,
    } as unknown as CreateCronJobInput,
    restatement: { what: '总结群消息', notifyWhen: '有新消息时' },
    description: '帮我盯一下群',
    sourceSessionId: 'session-1',
    ...(groupName ? { eventGroupName: groupName } : {}),
  };
}

const lastSchedule = { current: undefined as unknown };

const Harness: React.FC<{ initial: PendingScheduleDraft; onConfirm?: () => void }> = ({ initial, onConfirm }) => {
  const [draft, setDraft] = useState(initial);
  lastSchedule.current = draft.input.schedule;
  return (
    <ScheduleConfirmCard
      draft={draft}
      confirming={false}
      onConfirm={onConfirm ?? (() => undefined)}
      onDismiss={() => undefined}
      onDraftChange={setDraft}
    />
  );
};

const accountSelect = () => screen.getByLabelText(/^触发账号/) as HTMLSelectElement;
const chatSelect = () => screen.findByLabelText('限定会话 / 群（可选）') as Promise<HTMLSelectElement>;
const confirmButton = () => screen.getByRole('button', { name: '确认创建' }) as HTMLButtonElement;

describe('ScheduleConfirmCard event auto-preselect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('① single account + named group: account and group both preselected, no any-chat fallback', async () => {
    mockCatalog([workA], { 'acc-a': [{ id: 'oc_other', name: '闲聊群' }, { id: 'oc_rel', name: '发布群' }] });
    render(<Harness initial={makeDraft(1, '发布群')} />);

    await waitFor(() => expect(accountSelect().value).toBe('acc-a'));
    await waitFor(async () => expect((await chatSelect()).value).toBe('oc_rel'));
    expect(screen.queryByTestId('cron-event-chat-any-notice')).toBeNull();
    expect(screen.queryByTestId('cron-event-chat-not-found')).toBeNull();
    expect(confirmButton().disabled).toBe(false);
    expect(lastSchedule.current).toMatchObject({ accountId: 'acc-a', chatId: 'oc_rel' });
  });

  it('② several accounts: only the account whose catalog has the group is selected', async () => {
    mockCatalog([workA, workB], {
      'acc-a': [{ id: 'oc_x', name: '闲聊群' }],
      'acc-b': [{ id: 'oc_rel', name: '发布群' }],
    });
    render(<Harness initial={makeDraft(2, '发布群')} />);

    await waitFor(() => expect(accountSelect().value).toBe('acc-b'));
    await waitFor(async () => expect((await chatSelect()).value).toBe('oc_rel'));
  });

  it('② several accounts: same name in two accounts → nothing guessed', async () => {
    mockCatalog([workA, workB], {
      'acc-a': [{ id: 'oc_1', name: '发布群' }],
      'acc-b': [{ id: 'oc_2', name: '发布群' }],
    });
    render(<Harness initial={makeDraft(3, '发布群')} />);

    await waitFor(() => expect(ipc.invoke).toHaveBeenCalledWith(IPC_CHANNELS.CHANNEL_LIST_CONVERSATIONS, 'acc-b'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(accountSelect().value).toBe('');
    expect(confirmButton().disabled).toBe(true);
  });

  it('② several accounts: name in none → nothing guessed', async () => {
    mockCatalog([workA, workB], { 'acc-a': [{ id: 'oc_1', name: '闲聊群' }], 'acc-b': [] });
    render(<Harness initial={makeDraft(4, '发布群')} />);

    await waitFor(() => expect(ipc.invoke).toHaveBeenCalledWith(IPC_CHANNELS.CHANNEL_LIST_CONVERSATIONS, 'acc-b'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(accountSelect().value).toBe('');
  });

  it('② several accounts, no group named → nothing guessed', async () => {
    mockCatalog([workA, workB], { 'acc-a': [{ id: 'oc_1', name: '发布群' }] });
    render(<Harness initial={makeDraft(5)} />);

    await waitFor(() => expect(ipc.invoke).toHaveBeenCalledWith(IPC_CHANNELS.CHANNEL_LIST_CONVERSATIONS, 'acc-b'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(accountSelect().value).toBe('');
  });

  it('② manual choices are never overridden: user picks another group / clears the account', async () => {
    mockCatalog([workA, workB], {
      'acc-a': [{ id: 'oc_1', name: '发布群' }, { id: 'oc_2', name: '运营群' }],
      'acc-b': [{ id: 'oc_3', name: '运营群' }],
    });
    render(<Harness initial={makeDraft(6, '发布群')} />);
    await waitFor(() => expect(accountSelect().value).toBe('acc-a'));
    await waitFor(async () => expect((await chatSelect()).value).toBe('oc_1'));

    fireEvent.change(await chatSelect(), { target: { value: 'oc_2' } });
    expect((await chatSelect()).value).toBe('oc_2');

    // 用户改选另一个账号：不会被弹回自动预选的账号/群。
    fireEvent.change(accountSelect(), { target: { value: 'acc-b' } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(accountSelect().value).toBe('acc-b');
    expect((await chatSelect()).value).toBe('');
  });

  it('③ no group named: explicit "no group selected" notice, confirm stays enabled', async () => {
    mockCatalog([workA], { 'acc-a': [{ id: 'oc_rel', name: '发布群' }] });
    render(<Harness initial={makeDraft(7)} />);

    await waitFor(() => expect(accountSelect().value).toBe('acc-a'));
    const notice = await screen.findByTestId('cron-event-chat-any-notice');
    expect(notice.textContent).toBe(cc.eventChatAnyNotice);
    expect(notice.textContent).toContain('私聊');
    expect((await chatSelect()).value).toBe('');
    expect(confirmButton().disabled).toBe(false);
  });

  it('③ named group not in the account: not-found notice, confirm disabled until a group or "any chat" is explicitly chosen', async () => {
    mockCatalog([workA], { 'acc-a': [{ id: 'oc_rel', name: '发布群' }] });
    render(<Harness initial={makeDraft(8, '不存在的群')} />);

    await waitFor(() => expect(accountSelect().value).toBe('acc-a'));
    const notice = await screen.findByTestId('cron-event-chat-not-found');
    expect(notice.textContent).toContain(cc.eventChatNotFoundNotice.replace('{name}', '不存在的群'));
    expect(confirmButton().disabled).toBe(true);

    // 显式点「改为监听所有会话」放行（不是静默默认；原生 select 重选已选中项不触发 change，
    // 所以放行入口是独立按钮）；群名仍没找到，「没找到」提示继续留着。
    fireEvent.click(screen.getByTestId('cron-event-chat-choose-any'));
    await waitFor(() => expect(confirmButton().disabled).toBe(false));
    expect(screen.getByTestId('cron-event-chat-not-found')).toBeTruthy();
    expect(screen.getByTestId('cron-event-chat-any-chosen')).toBeTruthy();

    // 另一条路径：选具体群同样放行。
    fireEvent.change(await chatSelect(), { target: { value: 'oc_rel' } });
    expect(confirmButton().disabled).toBe(false);
    expect(screen.queryByTestId('cron-event-chat-not-found')).toBeNull();
  });

  it('③ named group, account has NO groups at all: the explicit button is the only way out and it works', async () => {
    mockCatalog([workA], { 'acc-a': [] });
    render(<Harness initial={makeDraft(11, '发布群')} />);

    await waitFor(() => expect(accountSelect().value).toBe('acc-a'));
    await screen.findByTestId('cron-event-chat-not-found');
    expect(confirmButton().disabled).toBe(true);
    // 下拉里只有「任意会话」一项，已选中，没有别的可切。
    expect((await chatSelect()).options.length).toBe(1);

    fireEvent.click(screen.getByTestId('cron-event-chat-choose-any'));
    await waitFor(() => expect(confirmButton().disabled).toBe(false));
  });

  it('③ manual-input branch (account cannot list chats): shows why confirm is blocked and offers the explicit way out', async () => {
    ipc.invoke.mockImplementation(async (channel: string) => {
      if (channel === IPC_CHANNELS.CHANNEL_LIST_ACCOUNTS) return [workA];
      if (channel === IPC_CHANNELS.CHANNEL_LIST_CONVERSATIONS) return { supported: false, conversations: [] };
      return undefined;
    });
    render(<Harness initial={makeDraft(12, '发布群')} />);

    await waitFor(() => expect(accountSelect().value).toBe('acc-a'));
    await screen.findByLabelText('会话 / 群 ID（可选）');
    expect(screen.getByTestId('cron-event-chat-not-found')).toBeTruthy();
    expect(confirmButton().disabled).toBe(true);

    fireEvent.click(screen.getByTestId('cron-event-chat-choose-any'));
    await waitFor(() => expect(confirmButton().disabled).toBe(false));
  });

  it('draft replacement resets: a new draft is auto-preselected again', async () => {
    mockCatalog([workA], { 'acc-a': [{ id: 'oc_rel', name: '发布群' }, { id: 'oc_ops', name: '运营群' }] });
    const first = makeDraft(9, '发布群');
    const { rerender } = render(
      <ScheduleConfirmCard draft={first} confirming={false} onConfirm={() => undefined} onDismiss={() => undefined} onDraftChange={() => undefined} />,
    );
    await waitFor(() => expect(accountSelect().value).toBe('acc-a'));

    // onDraftChange 是空操作，所以本卡的编辑态来自自动预选；换一份草案整体替换。
    rerender(
      <ScheduleConfirmCard draft={makeDraft(10, '运营群')} confirming={false} onConfirm={() => undefined} onDismiss={() => undefined} onDraftChange={() => undefined} />,
    );
    await waitFor(() => expect(accountSelect().value).toBe('acc-a'));
    await waitFor(async () => expect((await chatSelect()).value).toBe('oc_ops'));
  });
});

describe('CronEventScheduleFields without autoPreselect (editor behaviour unchanged)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('single account is NOT auto-selected and no notice is rendered', async () => {
    mockCatalog([workA], { 'acc-a': [{ id: 'oc_rel', name: '发布群' }] });
    render(
      <CronEventScheduleFields
        accountId=""
        chatId=""
        onAccountChange={() => undefined}
        onChatChange={() => undefined}
        maxRunBudget="0.5"
        onBudgetChange={() => undefined}
        validationMessage={null}
        preferredChatName="发布群"
      />,
    );
    await waitFor(() => expect(ipc.invoke).toHaveBeenCalledWith(IPC_CHANNELS.CHANNEL_LIST_CONVERSATIONS, 'acc-a'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((screen.getByLabelText(/^触发账号/) as HTMLSelectElement).value).toBe('');
    expect(screen.queryByTestId('cron-event-chat-any-notice')).toBeNull();
  });
});
