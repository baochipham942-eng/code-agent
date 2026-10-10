import type { ChannelMessage } from '../../shared/contract/channel';
import type { ChannelCommandName } from './channelCommand';
import { channelCommandText, formatChannelStatus } from './channelCommandI18n';
import type { InboundAccessLocale } from './inboundAccessI18n';

const STOP_RECEIPT_TIMEOUT_MS = 3_000;

interface ChannelCommandOrchestrator {
  isProcessing(): boolean;
  cancel(reason: 'user'): Promise<void>;
}

interface ChannelCommandHealth {
  currentTokens: number;
  maxTokens: number;
  usagePercent: number;
  tokenSource?: 'provider' | 'estimated';
}

export interface ChannelCommandDeps {
  locale: InboundAccessLocale;
  lookupSessionId(message: ChannelMessage): string | undefined;
  forgetPairedSession(message: ChannelMessage): void;
  getOrchestrator(sessionId: string): ChannelCommandOrchestrator | null;
  getContextHealth(sessionId: string): ChannelCommandHealth;
  findRecoveredWaitingRun(sessionId: string): { runId: string; sessionId: string } | undefined;
  hasUnstoppableRun(sessionId: string, hasOrchestrator: boolean): boolean;
  markRunStopped(sessionId: string): void;
  sleep(ms: number): Promise<void>;
}

export async function handleChannelCommand(
  deps: ChannelCommandDeps,
  message: ChannelMessage,
  command: ChannelCommandName,
): Promise<string> {
  switch (command) {
    case 'stop':
      return stopChannelRun(deps, message);
    case 'new':
      return startNewChannelSession(deps, message);
    case 'status':
      return readChannelStatus(deps, message);
  }
}

async function stopChannelRun(deps: ChannelCommandDeps, message: ChannelMessage): Promise<string> {
  const sessionId = deps.lookupSessionId(message);
  if (!sessionId) return channelCommandText(deps.locale, 'nothingRunning');
  const orchestrator = deps.getOrchestrator(sessionId);
  if (orchestrator?.isProcessing()) return cancelWithReceipt(deps, sessionId, orchestrator);
  if (deps.findRecoveredWaitingRun(sessionId) || deps.hasUnstoppableRun(sessionId, orchestrator != null)) {
    return channelCommandText(deps.locale, 'cannotStop');
  }
  return channelCommandText(deps.locale, 'nothingRunning');
}

async function cancelWithReceipt(
  deps: ChannelCommandDeps,
  sessionId: string,
  orchestrator: ChannelCommandOrchestrator,
): Promise<string> {
  // The in-flight turn observes this before cancel unwinds into its filler reply.
  deps.markRunStopped(sessionId);
  let finished = false;
  const cancelPromise = orchestrator.cancel('user').then(() => {
    finished = true;
  }, () => {
    finished = false;
  });
  await Promise.race([cancelPromise, deps.sleep(STOP_RECEIPT_TIMEOUT_MS)]);
  return channelCommandText(deps.locale, finished ? 'stopped' : 'windingDown');
}

async function startNewChannelSession(deps: ChannelCommandDeps, message: ChannelMessage): Promise<string> {
  const sessionId = deps.lookupSessionId(message);
  if (sessionId && deps.getOrchestrator(sessionId)?.isProcessing()) {
    return channelCommandText(deps.locale, 'newWhileRunning');
  }
  deps.forgetPairedSession(message);
  return channelCommandText(deps.locale, 'newConversation');
}

async function readChannelStatus(deps: ChannelCommandDeps, message: ChannelMessage): Promise<string> {
  const sessionId = deps.lookupSessionId(message);
  if (!sessionId) return formatChannelStatus(deps.locale, 'idle', null);
  const orchestrator = deps.getOrchestrator(sessionId);
  const recovered = deps.findRecoveredWaitingRun(sessionId);
  const state = orchestrator?.isProcessing()
    ? 'running'
    : recovered
      ? 'paused-resumable'
      : deps.hasUnstoppableRun(sessionId, orchestrator != null)
        ? 'running'
        : 'idle';
  const health = deps.getContextHealth(sessionId);
  return formatChannelStatus(deps.locale, state, isEmptyContextHealth(health) ? null : health);
}

function isEmptyContextHealth(health: ChannelCommandHealth): boolean {
  return health.tokenSource === undefined && health.currentTokens === 0 && health.usagePercent === 0;
}
