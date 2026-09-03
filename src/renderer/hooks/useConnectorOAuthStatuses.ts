// ============================================================================
// useConnectorOAuthStatuses —— CLI / SaaS 连接器（feishu/tmeet…）的登录态
// ============================================================================
// 原生连接器（mail/calendar…）的状态走 connector/listStatuses，而 CLI / SaaS 那支的
// 登录态在另一条「oauthStatus」通道里——设置页 SaaSConnectorsSection 读的就是它。
// 底栏 chip 要回答「这个连接器连上了没」，两条都得看；只看 listStatuses 会把连好的
// 飞书恒判成「未连接」（假 CTA + 假警示点，与宿主 isConnectorReadyForTurnScope 打架）。
//
// oauthStatus 没有变更推送（CONNECTOR_EVENT 只广播原生那支），所以除挂载时拉一次外，
// 由调用方给 refreshKey（典型是手选列表）——用户在设置里连好再点「去使用」跳回来，
// 选择一变就重拉。
// ============================================================================

import { useEffect, useState } from 'react';
import { IPC_DOMAINS } from '@shared/ipc';
import ipcService from '../services/ipcService';

export interface ConnectorOAuthStatus {
  id: string;
  connected: boolean;
  stale?: boolean;
}

function parseStatuses(payload: unknown): ConnectorOAuthStatus[] {
  if (!Array.isArray(payload)) return [];
  return payload.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const { id, connected, stale } = item as Record<string, unknown>;
    if (typeof id !== 'string' || typeof connected !== 'boolean') return [];
    return [{ id, connected, stale: stale === true }];
  });
}

export function useConnectorOAuthStatuses(refreshKey: string, enabled = true): ConnectorOAuthStatus[] {
  const [statuses, setStatuses] = useState<ConnectorOAuthStatus[]>([]);

  useEffect(() => {
    // 没有 CLI/SaaS 连接器在场时不拉——oauthStatus 冷缓存会对 feishu/tmeet 起 CLI
    // 子进程做 status()，不能让它落在每个输入区的渲染路径上
    if (!enabled) return undefined;
    let cancelled = false;
    void ipcService.invokeDomain<unknown>(IPC_DOMAINS.CONNECTOR, 'oauthStatus')
      .then((payload) => { if (!cancelled) setStatuses(parseStatuses(payload)); })
      // 拉取失败保留旧值——清空会把已连好的连接器瞬间翻成「未连接」并冒出假 CTA
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [refreshKey, enabled]);

  return statuses;
}
