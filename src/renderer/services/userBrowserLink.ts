import type { SurfaceConversationSnapshotV1 } from '@shared/contract/surfaceExecution';
import { IPC_DOMAINS } from '@shared/ipc';
import { useAppStore } from '../stores/appStore';
import { useSurfaceExecutionStore } from '../stores/surfaceExecutionStore';
import { createLogger } from '../utils/logger';

const logger = createLogger('UserBrowserLink');

interface OpenLinkInRailResult {
  conversationId: string;
  runId: string;
  surfaceSessionId: string;
  snapshot: SurfaceConversationSnapshotV1;
}

export interface OpenHttpLinkInRailInput {
  href: string | undefined;
  conversationId: string | null | undefined;
  workspace: string | null | undefined;
}

export type UserBrowserHistoryAction = 'back' | 'forward' | 'reload';

function domainBridge() {
  return window.codeAgentDomainAPI || window.domainAPI;
}

function validateOpenInput(input: OpenHttpLinkInRailInput): {
  href: string;
  conversationId: string;
  workspace: string;
} | null {
  const href = input.href?.trim();
  const conversationId = input.conversationId?.trim();
  // workspace 允许缺省：host 侧会按会话解析、再兜底默认 work 目录（空态自动建会话场景）。
  const workspace = input.workspace?.trim() ?? '';
  if (!href || !conversationId || !/^https?:\/\//i.test(href)) {
    return null;
  }
  return { href, conversationId, workspace };
}

/**
 * 同步「是否已受理」闸门（聊天链接点击等调用方依赖 truthy 立刻 preventDefault）。
 * 真正的成功/失败请用 openHttpLinkInRailAsync。
 */
export function openHttpLinkInRail(input: OpenHttpLinkInRailInput): boolean {
  if (!domainBridge() || !validateOpenInput(input)) return false;
  void openHttpLinkInRailAsync(input).catch(() => undefined);
  return true;
}

/** 打开链接并等待 host 导航 + snapshot 回写；失败抛错供 pending 态失败分支。 */
export async function openHttpLinkInRailAsync(input: OpenHttpLinkInRailInput): Promise<OpenLinkInRailResult> {
  const validated = validateOpenInput(input);
  const bridge = domainBridge();
  if (!bridge || !validated) {
    throw new Error('Invalid browser navigation request.');
  }
  const { href, conversationId, workspace } = validated;

  useAppStore.getState().openWorkbenchTab('browser', { source: 'user' });
  try {
    const response = await bridge.invoke<OpenLinkInRailResult>(
      IPC_DOMAINS.WORKSPACE,
      'openLinkInRail',
      { conversationId, url: href, workspace },
    );
    if (!response.success || !response.data) {
      throw new Error(response.error?.message || 'Failed to open link in browser rail.');
    }
    const applied = useSurfaceExecutionStore.getState().setNativeSnapshot(
      conversationId,
      response.data.snapshot,
    );
    if (applied === 'invalid') {
      throw new Error('Browser rail returned an invalid Surface snapshot.');
    }
    return response.data;
  } catch (error) {
    logger.error('Failed to open http(s) link in browser rail', error, { conversationId, href });
    throw error instanceof Error ? error : new Error(String(error));
  }
}

export async function controlUserBrowserHistory(input: {
  conversationId: string | null | undefined;
  workspace: string | null | undefined;
  action: UserBrowserHistoryAction;
}): Promise<SurfaceConversationSnapshotV1 | null> {
  const conversationId = input.conversationId?.trim();
  // workspace 允许缺省：与 openLinkInRail 同口径，host 按会话/默认 work 目录兜底。
  const workspace = input.workspace?.trim() ?? '';
  const bridge = domainBridge();
  if (!bridge || !conversationId) {
    throw new Error('Browser history control requires conversation.');
  }
  const response = await bridge.invoke<SurfaceConversationSnapshotV1 | null>(
    IPC_DOMAINS.WORKSPACE,
    'controlUserBrowserHistory',
    { conversationId, workspace, action: input.action },
  );
  if (!response.success) {
    throw new Error(response.error?.message || `Browser ${input.action} failed.`);
  }
  if (response.data) {
    useSurfaceExecutionStore.getState().setNativeSnapshot(conversationId, response.data);
  }
  return response.data ?? null;
}

/** 画面交互透传（点击/滚轮/键盘/IME 整段文本）。失败抛错，调用方静默或记日志。 */
export async function dispatchUserBrowserInput(input: {
  conversationId: string | null | undefined;
  workspace: string | null | undefined;
  input: unknown;
}): Promise<SurfaceConversationSnapshotV1 | null> {
  const conversationId = input.conversationId?.trim();
  // workspace 允许缺省：快速对话无 cwd 时 host 兜底（R2：client 必填会零 dispatch）。
  const workspace = input.workspace?.trim() ?? '';
  const bridge = domainBridge();
  if (!bridge || !conversationId) {
    throw new Error('Browser input requires conversation.');
  }
  const response = await bridge.invoke<SurfaceConversationSnapshotV1 | null>(
    IPC_DOMAINS.WORKSPACE,
    'dispatchUserBrowserInput',
    { conversationId, workspace, input: input.input },
  );
  if (!response.success) {
    throw new Error(response.error?.message || 'Browser input failed.');
  }
  if (response.data) {
    useSurfaceExecutionStore.getState().setNativeSnapshot(conversationId, response.data);
  }
  return response.data ?? null;
}

export async function closeUserBrowserLinkRun(
  conversationId: string,
  reason: 'user' | 'session-switch',
): Promise<void> {
  const bridge = domainBridge();
  if (!bridge || !conversationId.trim()) return;
  try {
    const response = await bridge.invoke<SurfaceConversationSnapshotV1 | null>(
      IPC_DOMAINS.WORKSPACE,
      'closeLinkInRail',
      { conversationId, reason },
    );
    if (!response.success) throw new Error(response.error?.message || 'Failed to close browser rail run.');
    if (response.data) {
      useSurfaceExecutionStore.getState().setNativeSnapshot(conversationId, response.data);
    }
  } catch (error) {
    logger.error('Failed to close user browser rail run', error, { conversationId, reason });
  }
}
