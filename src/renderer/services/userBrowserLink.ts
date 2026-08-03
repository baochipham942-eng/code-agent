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

function domainBridge() {
  return window.codeAgentDomainAPI || window.domainAPI;
}

export function openHttpLinkInRail(input: OpenHttpLinkInRailInput): boolean {
  const href = input.href?.trim();
  const conversationId = input.conversationId?.trim();
  const workspace = input.workspace?.trim();
  const bridge = domainBridge();
  if (!bridge || !href || !conversationId || !workspace || !/^https?:\/\//i.test(href)) {
    return false;
  }

  useAppStore.getState().openWorkbenchTab('browser', { source: 'user' });
  void bridge.invoke<OpenLinkInRailResult>(
    IPC_DOMAINS.WORKSPACE,
    'openLinkInRail',
    { conversationId, url: href, workspace },
  ).then((response) => {
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
  }).catch((error) => {
    logger.error('Failed to open http(s) link in browser rail', error, { conversationId, href });
  });
  return true;
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
