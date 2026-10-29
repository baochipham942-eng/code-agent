// N-BROWSER-KEEP-RESULT-PAGE：WORKSPACE 域 kept 结果页两条 action 的 handler 逻辑。
// 表项留在 workspace.ipc.ts（parity 门按表枚举），本模块承载实现，避免把已 998
// 有效行的 handler 表文件顶过 max-lines=1000。

import type { UserBrowserLinkService, UserBrowserLinkResult } from '../services/surfaceExecution/UserBrowserLinkService';
import type { KeptResultPageSnapshot } from '../services/surfaceExecution/keptBrowserRegistry';
import { getDefaultWorkDirectory } from '../config/configPaths';

type KeptResultPageLinks = Pick<UserBrowserLinkService, 'adopt' | 'keptState'>;

/** getKeptResultPage：kept 结果页三态（none/kept/closed + url/title）。 */
export function getKeptResultPageHandler(
  links: KeptResultPageLinks,
  payload: unknown,
): KeptResultPageSnapshot {
  const keptPayload = payload as { conversationId?: string };
  return links.keptState(keptPayload.conversationId || '');
}

/**
 * adoptKeptResultPage：用户认领 kept 结果页（不导航，接上活窗），返回与
 * openLinkInRail 同形快照。
 */
export async function adoptKeptResultPageHandler(
  links: KeptResultPageLinks,
  payload: unknown,
): Promise<UserBrowserLinkResult> {
  const adoptPayload = payload as { conversationId: string; workspace?: string };
  return await links.adopt({
    conversationId: adoptPayload.conversationId,
    workspace: await resolveUserBrowserWorkspace(adoptPayload.conversationId, adoptPayload.workspace),
  });
}

/**
 * 用户浏览器链路（open / adopt / history / 画面透传）的 workspace 解析。
 * 快速对话常无 workingDirectory：按会话目录 → getDefaultWorkDirectory() 兜底，
 * 各条 IPC 必须同口径，否则「能开页看得见画面，却点不动/退不了」
 * （2026-08-05 R2 真机：open 有兜底、dispatch/history 没有）。
 */
export async function resolveUserBrowserWorkspace(
  conversationId: string | undefined,
  workspace?: string | null,
): Promise<string> {
  let resolved = workspace?.trim() || undefined;
  if (!resolved && conversationId?.trim()) {
    try {
      const { getSessionManager } = await import('../services/infra/sessionManager');
      resolved = (await getSessionManager().getSession(conversationId.trim(), 1))?.workingDirectory ?? undefined;
    } catch {
      // DB 未初始化/会话缺失时不阻断：落到默认 work 目录（单测与冷启动同路径）
      resolved = undefined;
    }
  }
  if (!resolved) {
    const fsMod = await import('fs');
    resolved = getDefaultWorkDirectory();
    await fsMod.promises.mkdir(resolved, { recursive: true });
  }
  return resolved;
}
