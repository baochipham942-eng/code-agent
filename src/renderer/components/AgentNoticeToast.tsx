// ============================================================================
// AgentNoticeToast - agent:notice 事件订阅（headless，复用 BudgetAlertNotice 范式）
// ============================================================================
// host 侧发结构化 reason code + 参数（AgentNoticeEvent），这里按 i18n 模板渲染成 toast。
// 2026-08-08：接管此前挂在 AgentEvent 'notification' 分支、渲染侧零消费者的 5 处甲类通知。
import { useEffect } from 'react';
import { toast } from '../hooks/useToast';
import { ipcService } from '../services/ipcService';
import { IPC_CHANNELS } from '@shared/ipc';
import type { AgentNoticeEvent } from '@shared/ipc/handlers';
import { useI18n } from '../hooks/useI18n';
import type { Translations } from '../i18n';

const WARNING_REASON_CODES = new Set<AgentNoticeEvent['reasonCode']>([
  'heartbeat_check_failed',
  'heartbeat_status_alert',
]);

export function formatAgentNoticeToast(event: AgentNoticeEvent, t: Translations): string {
  const an = t.notices.agentNotice;
  const params = event.params ?? {};
  switch (event.reasonCode) {
    case 'heartbeat_check_failed':
      return an.heartbeatCheckFailed
        .replace('{name}', params.name ?? '')
        .replace('{error}', params.error ?? '')
        .replace('{count}', String(params.consecutiveFailures ?? 0));
    case 'heartbeat_status_alert':
      return an.heartbeatStatusAlert
        .replace('{name}', params.name ?? '')
        .replace('{status}', params.status ?? '');
    case 'auto_agent_awaiting_approval':
      return an.autoAgentAwaitingApproval;
    case 'delegate_mode_active':
      return an.delegateModeActive;
    case 'agent_routed':
      return an.agentRouted.replace('{agentName}', params.agentName ?? '');
    default: {
      // 穷举检查：新增 reasonCode 忘记在这里加分支会在此处报编译错误
      const exhaustive: never = event.reasonCode;
      return exhaustive;
    }
  }
}

/**
 * 订阅 agent:notice 事件并弹 toast。heartbeat 系告警走 warning，其余为 info。
 */
export function AgentNoticeToast(): null {
  const { t } = useI18n();
  useEffect(() => {
    const unsubscribe = ipcService.on(IPC_CHANNELS.AGENT_NOTICE, (event: AgentNoticeEvent) => {
      const message = formatAgentNoticeToast(event, t);
      if (WARNING_REASON_CODES.has(event.reasonCode)) {
        toast.warning(message);
      } else {
        toast.info(message);
      }
    });
    return () => {
      unsubscribe?.();
    };
  }, [t]);

  return null;
}
