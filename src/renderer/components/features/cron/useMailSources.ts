// ============================================================================
// useMailSources —— 「新邮件」触发源的本机 Mail 账号/邮箱目录（N-TRIGGER-MAIL-CREATE-ENTRY-K1）。
// 数据来自 cron:listMailSources（host 侧经 mail 连接器 list_accounts/list_mailboxes），
// 编辑器与 /schedule 确认卡的账号/邮箱下拉共用这一份，绑定口径一致。不可用分支
// 带 reason 分类（缺件 ≠ 未授权 ≠ 平台不支持 ≠ 读取失败），渲染层给可区分提示。
// ============================================================================

import { useCallback, useEffect, useState } from 'react';
import type { CronMailSourceAccount, CronMailSourcesResult } from '@shared/contract';
import { cronClient } from '../../../services/cronClient';

export type MailSourcesState =
  | { status: 'loading' }
  | { status: 'ready'; accounts: CronMailSourceAccount[]; mailboxesByAccount: Record<string, string[]> }
  | { status: 'empty'; accounts: []; mailboxesByAccount: Record<string, never> }
  | { status: 'unavailable'; reason: Extract<CronMailSourcesResult, { ok: false }>['reason']; detail?: string };

export function useMailSources(): { state: MailSourcesState; reload: () => void } {
  const [state, setState] = useState<MailSourcesState>({ status: 'loading' });
  // reload 用递增序号触发 effect 重跑（同 hook 内消费，不进 store）。
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((current) => current + 1), []);

  useEffect(() => {
    let active = true;
    setState({ status: 'loading' });
    cronClient.listMailSources()
      .then((result) => {
        if (!active) return;
        if (result.ok && result.accounts.length > 0) {
          setState({ status: 'ready', accounts: result.accounts, mailboxesByAccount: result.mailboxesByAccount });
        } else if (result.ok) {
          // 授权通过但 Mail 里没有账户：与「读取失败/未授权」分开陈述。
          setState({ status: 'empty', accounts: [], mailboxesByAccount: {} });
        } else {
          setState({ status: 'unavailable', reason: result.reason, detail: result.detail });
        }
      })
      .catch(() => {
        // IPC 层失败（如旧壳不认识新 action）：按读取失败陈述，不炸字段区。
        if (active) setState({ status: 'unavailable', reason: 'read-error' });
      });
    return () => {
      active = false;
    };
  }, [attempt]);

  return { state, reload };
}
