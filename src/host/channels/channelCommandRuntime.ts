import type { ChannelMessage } from '../../shared/contract/channel';
import { getApplicationRunRegistry } from '../app/applicationRunRegistry';
import { getContextHealthService } from '../context/contextHealthService';
import { createLogger } from '../services/infra/logger';
import { getTaskManager } from '../task';
import { type ChannelCommandName, parseChannelCommand } from './channelCommand';
import { handleChannelCommand, type ChannelCommandDeps } from './channelCommandHandler';
import { channelCommandText } from './channelCommandI18n';
import type { InboundAccessLocale } from './inboundAccessI18n';

export { parseChannelCommand };

const logger = createLogger('ChannelCommand');
const stoppedChannelRuns = new Set<string>();

interface ChannelCommandHooks {
  guest: boolean;
  locale: InboundAccessLocale;
  lookupSessionId(message: ChannelMessage): string | undefined;
  forgetPairedSession(message: ChannelMessage): void;
  send(text: string): Promise<void>;
  complete(): void;
  fail(): void;
}

function noteStoppedChannelRun(sessionId: string): void {
  if (sessionId) stoppedChannelRuns.add(sessionId);
}

export function consumeStoppedChannelRun(sessionId: string): boolean {
  return sessionId.length > 0 && stoppedChannelRuns.delete(sessionId);
}

export function clearStoppedChannelRuns(): void {
  stoppedChannelRuns.clear();
}

function buildChannelCommandDeps(hooks: ChannelCommandHooks): ChannelCommandDeps {
  return {
    locale: hooks.locale,
    lookupSessionId: (message) => hooks.lookupSessionId(message),
    forgetPairedSession: (message) => hooks.forgetPairedSession(message),
    getOrchestrator: (sessionId) => {
      const orchestrator = getTaskManager().getOrchestrator(sessionId);
      if (!orchestrator) return null;
      return {
        isProcessing: () => orchestrator.isProcessing(),
        cancel: (reason) => orchestrator.cancel(reason),
      };
    },
    getContextHealth: (sessionId) => getContextHealthService().get(sessionId),
    findRecoveredWaitingRun: (sessionId) => getApplicationRunRegistry().findRecoveredWaitingRun({ sessionId }),
    hasUnstoppableRun: (sessionId, hasOrchestrator) => hasUnstoppableChannelRun(sessionId, hasOrchestrator),
    markRunStopped: noteStoppedChannelRun,
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  };
}

/**
 * Channel sessions only build a native orchestrator. A registry run with no local
 * orchestrator — external engine, cloud, or a handle-less owner — cannot be cancelled here.
 * Recovered waiting runs are reported separately by findRecoveredWaitingRun.
 */
function hasUnstoppableChannelRun(sessionId: string, hasOrchestrator: boolean): boolean {
  const registry = getApplicationRunRegistry();
  if (!registry.hasSession(sessionId)) return false;
  if (!hasOrchestrator) return true;
  const handle = registry.getBySessionId(sessionId);
  if (!handle) return true;
  const envelope = registry.getDurableEnvelope(handle.context.runId);
  return envelope !== undefined && envelope.engine.kind !== 'native';
}

export async function deliverChannelCommandText(
  hooks: ChannelCommandHooks,
  command: ChannelCommandName,
  message: ChannelMessage,
): Promise<void> {
  try {
    const text = hooks.guest
      ? channelCommandText(hooks.locale, 'unauthorized')
      : await handleChannelCommand(buildChannelCommandDeps(hooks), message, command);
    await hooks.send(text);
    hooks.complete();
  } catch (error) {
    hooks.fail();
    logger.error('Channel command failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
