// ============================================================================
// useChannelCatalog —— 已连接通道账号 + 各账号会话目录（IPC 拉取）。
// 自 CronResultChannel.tsx 抽出（N-CRON-EVENT-CREATE-UI）：结果推送字段与
// 事件触发源选择共用同一份目录，账号/会话口径永远一致。
// ============================================================================

import { useCallback, useEffect, useState } from 'react';
import type { CronJobDefinition } from '@shared/contract';
import type {
  ChannelAccount,
  ChannelConversationListResponse,
} from '@shared/contract/channel';
import { IPC_CHANNELS } from '@shared/ipc';
import ipcService from '../../../services/ipcService';
import type { EventScheduleDisplayNames } from './types';

interface ConversationState extends ChannelConversationListResponse {
  loading: boolean;
}

export function useChannelCatalog(): {
  accounts: ChannelAccount[];
  accountsLoading: boolean;
  conversationsByAccount: Record<string, ConversationState>;
} {
  const [accounts, setAccounts] = useState<ChannelAccount[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [conversationsByAccount, setConversationsByAccount] = useState<Record<string, ConversationState>>({});

  useEffect(() => {
    let active = true;
    void Promise.resolve(ipcService.invoke(IPC_CHANNELS.CHANNEL_LIST_ACCOUNTS))
      .then((items) => {
        if (active) setAccounts(items || []);
      })
      .catch(() => {
        if (active) setAccounts([]);
      })
      .finally(() => {
        if (active) setAccountsLoading(false);
      });

    const removeListener = ipcService.on(
      IPC_CHANNELS.CHANNEL_ACCOUNTS_CHANGED,
      (items: ChannelAccount[]) => setAccounts(items),
    );
    return () => {
      active = false;
      removeListener?.();
    };
  }, []);

  useEffect(() => {
    let active = true;
    setConversationsByAccount(Object.fromEntries(
      accounts.map((account) => [account.id, {
        supported: true,
        conversations: [],
        loading: true,
      }]),
    ));

    void Promise.all(accounts.map(async (account): Promise<readonly [string, ConversationState]> => {
      try {
        const result = await Promise.resolve(
          ipcService.invoke(IPC_CHANNELS.CHANNEL_LIST_CONVERSATIONS, account.id),
        );
        return [account.id, { ...result, loading: false }] as const;
      } catch (error) {
        return [account.id, {
          supported: true,
          conversations: [],
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        }] as const;
      }
    })).then((entries) => {
      if (active) setConversationsByAccount(Object.fromEntries(entries));
    });

    return () => {
      active = false;
    };
  }, [accounts]);

  return { accounts, accountsLoading, conversationsByAccount };
}

/**
 * event 任务摘要的显示名解析（N-CRON-EVENT-CREATE-UI r2）：列表/详情行里
 * accountId/chatId 换成通道目录里的账号名/群名；目录没有（账号已删、群不在
 * 最近会话里、还没加载完）回落 id，由 formatScheduleSummary 兜底。
 */
export function useEventScheduleNames(): (job: CronJobDefinition) => EventScheduleDisplayNames {
  const { accounts, conversationsByAccount } = useChannelCatalog();
  return useCallback((job: CronJobDefinition): EventScheduleDisplayNames => {
    if (job.schedule?.type !== 'event') return {};
    const schedule = job.schedule;
    return {
      accountName: accounts.find((account) => account.id === schedule.accountId)?.name,
      chatName: schedule.chatId
        ? conversationsByAccount[schedule.accountId]?.conversations.find(
            (conversation) => conversation.id === schedule.chatId,
          )?.name
        : undefined,
    };
  }, [accounts, conversationsByAccount]);
}
