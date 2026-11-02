// ============================================================================
// Browser risky-target gate for sessions where a Jev run handed back (N-JEV-BROWSER-ARMED-REST2-FU1)
// Jev's inner loop asks forceConfirm approval before clicking pay/delete/authorize targets, but the
// main-model Browser tool has no such gate. After a Jev hand-back the main model continues the same
// task in the same session, so the approval must follow it. Sessions where Jev never ran are untouched.
// ============================================================================

import type { ToolContext, ToolExecutionResult } from '../types';
import { createLogger } from '../../services/infra/logger';
import { BROWSER_RISK_KEYWORD, isBrowserJevHandbackSession } from '../../agent/runtime/browser/jevBrowserRisk';

const logger = createLogger('BrowserRiskGate', { lane: 'browser' });

const GATED_ACTIONS = new Set<string>(['click', 'click_text', 'type', 'press_key']);

interface RiskGateBrowserService {
  findElements?(selector: string, tabId?: string): Promise<Array<{ text?: string; attributes?: Record<string, string> }>>;
  resolveTargetRef?(targetRef: unknown, tabId?: string): Promise<{ targetRef: { name?: string | null; textHint?: string | null } }>;
}

export interface BrowserRiskGateInput {
  action: string;
  params: Record<string, unknown>;
  browserService: RiskGateBrowserService;
  tabId?: string;
  context: Pick<ToolContext, 'requestPermission' | 'sessionId'>;
}

async function targetLabels(input: BrowserRiskGateInput): Promise<string[] | null> {
  const { params } = input;
  const labels: string[] = [];
  for (const key of ['selector', 'text'] as const) {
    const value = params[key];
    if (typeof value === 'string' && value && (key === 'selector' || input.action === 'click_text')) labels.push(value);
  }
  // A CSS selector rarely carries the visible label (RBS-07: `button.added-manually` is the "Delete" button),
  // so read the first matched element's text/aria-label too: that is the element page.click would hit.
  if (typeof params.selector === 'string' && params.selector && input.action !== 'press_key') {
    if (!input.browserService.findElements) {
      logger.warn('browser risk gate: selector label unresolved (service has no findElements), selector text only');
    } else {
      try {
        const [first] = await input.browserService.findElements(params.selector, input.tabId);
        labels.push(first?.text || '', first?.attributes?.['aria-label'] || '', first?.attributes?.value || '', first?.attributes?.title || '');
      } catch (error) {
        logger.warn(`browser risk gate: selector label unresolved (${error instanceof Error ? error.message : 'unknown'}), selector text only`);
      }
    }
  }
  if (params.targetRef) {
    if (!input.browserService.resolveTargetRef) {
      logger.warn('browser risk gate: target label unresolved (service has no resolveTargetRef), gate skipped');
      return null;
    }
    try {
      const { targetRef } = await input.browserService.resolveTargetRef(params.targetRef, input.tabId);
      labels.push(targetRef.name || '', targetRef.textHint || '');
    } catch (error) {
      logger.warn(`browser risk gate: target label unresolved (${error instanceof Error ? error.message : 'unknown'}), gate skipped`);
      return null;
    }
  }
  if (labels.length === 0 && input.action === 'press_key') {
    logger.warn('browser risk gate: press_key has no resolvable target label, gate skipped');
    return null;
  }
  return labels;
}

/** Denied approval returns SURFACE_APPROVAL_REQUIRED; non-gated sessions/actions/targets return null. */
export async function enforceBrowserJevHandbackRiskGate(
  input: BrowserRiskGateInput,
): Promise<ToolExecutionResult | null> {
  const sessionId = input.context.sessionId;
  if (!GATED_ACTIONS.has(input.action) || !sessionId || !isBrowserJevHandbackSession(sessionId)) {
    return null;
  }
  const labels = await targetLabels(input);
  if (!labels?.some((label) => BROWSER_RISK_KEYWORD.test(label))) {
    return null;
  }
  const target = labels.filter(Boolean).join(' / ');
  const approved = await input.context.requestPermission({
    type: 'dangerous_command',
    tool: `browser_action.${input.action}`,
    forceConfirm: true,
    dangerLevel: 'danger',
    reason: 'Jev 已交回，主模型接手后的动作可能确认支付、删除或授权，必须对当前动作显式批准。',
    details: { action: input.action, target },
  });
  if (approved) return null;
  logger.warn(`browser risk gate: blocked "${input.action}" on "${target}" after jev hand-back (session=${sessionId})`);
  return {
    success: false,
    error: `Action ${input.action} on "${target}" after a Jev hand-back matches a pay/delete/authorize risk and needs explicit approval; ask the user before retrying.`,
    metadata: { code: 'SURFACE_APPROVAL_REQUIRED', userActionRequired: true },
  };
}
