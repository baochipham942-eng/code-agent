import type { SurfaceSessionControlActionV1 } from '@shared/contract/surfaceExecution';
import { executeSurfaceExecutionControl } from '../services/surfaceExecutionController';
import { createLogger } from '../utils/logger';

const logger = createLogger('BrowserHumanTakeover');

async function requestBrowserSurfaceControl(input: {
  conversationId: string | null;
  surfaceSessionId: string | null;
  action: Extract<SurfaceSessionControlActionV1, 'takeover' | 'resume'>;
}): Promise<void> {
  if (!input.conversationId || !input.surfaceSessionId) {
    logger.warn('Browser surface control skipped because the session identity is missing', {
      action: input.action,
    });
    return;
  }
  try {
    await executeSurfaceExecutionControl({
      version: 1,
      conversationId: input.conversationId,
      surfaceSessionId: input.surfaceSessionId,
      action: input.action,
    });
  } catch (error) {
    logger.warn('Browser surface control failed; the user action still continues', {
      action: input.action,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Tell the host to take over before the user's click or address-bar navigation lands. */
export function requestBrowserHumanTakeover(input: {
  conversationId: string | null;
  surfaceSessionId: string | null;
}): Promise<void> {
  return requestBrowserSurfaceControl({ ...input, action: 'takeover' });
}

/** Continue button: the host resumes the agent on the page the user left open. */
export function resumeBrowserHumanTakeover(input: {
  conversationId: string | null;
  surfaceSessionId: string | null;
}): Promise<void> {
  return requestBrowserSurfaceControl({ ...input, action: 'resume' });
}

/**
 * Address-bar confirm awaits takeover, then navigates.
 * Stage confirm is the hook's own path so this does not take over twice.
 */
export async function confirmLiveBrowserInterrupt(input: {
  pendingUrl: string | null;
  clearPendingUrl: () => void;
  navigateTo: (url: string) => Promise<void> | void;
  confirmStagePreempt: () => void;
  conversationId: string | null;
  surfaceSessionId: string | null;
}): Promise<void> {
  if (input.pendingUrl) {
    const url = input.pendingUrl;
    input.clearPendingUrl();
    await requestBrowserHumanTakeover({
      conversationId: input.conversationId,
      surfaceSessionId: input.surfaceSessionId,
    });
    await input.navigateTo(url);
    return;
  }
  input.confirmStagePreempt();
}
