// ============================================================================
// Browser captcha / risk-control takeover gate (N-BROWSER-CAPTCHA-TAKEOVER)
// 页面命中人机验证 / 风控 / MFA / 登录墙分类时，变更动作强制进人审门；
// 不靠模型自觉，用户指令「绕过」不能绕过这道门（复用现有分类器，不另造第二套）。
// 只读动作（screenshot / get_content / get_dom_snapshot / scroll 等）不受影响。
// ============================================================================

import type { ToolContext, ToolExecutionResult } from '../types';
import { classifyBrowserComputerManualTakeover } from '../../../shared/utils/browserComputerRedaction';

const GATED_TAKEOVER_CLASSES = new Set<string>(['captcha_or_risk_control', 'mfa_required']);
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('BrowserCaptchaGate', { lane: 'browser' });

/** 变更类动作：页面命中人机验证/风控分类时必须经 forceConfirm 审批。 */
const BROWSER_CAPTCHA_MUTATION_ACTIONS = new Set<string>([
  'click',
  'click_text',
  'type',
  'press_key',
  'drag',
  'fill_form',
  'upload_file',
]);

interface CaptchaGateBrowserService {
  getPageContent(tabId?: string): Promise<{ url: string; title: string; text: string }>;
}

export interface BrowserCaptchaGateInput {
  action: string;
  browserService: CaptchaGateBrowserService;
  tabId?: string;
  context: Pick<ToolContext, 'requestPermission'>;
}

/**
 * 命中分类时返回 `manual_takeover_required` 失败结果（审批被拒），否则返回 null 放行。
 * 页面内容读不到时放行并留痕——动作自身会在无标签页等场景自然失败。
 */
export async function enforceBrowserCaptchaTakeoverGate(
  input: BrowserCaptchaGateInput,
): Promise<ToolExecutionResult | null> {
  if (!BROWSER_CAPTCHA_MUTATION_ACTIONS.has(input.action)) {
    return null;
  }
  let url: string;
  let visibleText: string;
  try {
    const content = await input.browserService.getPageContent(input.tabId);
    url = content?.url || '';
    visibleText = [content?.title || '', content?.text || ''].join('\n');
  } catch (error) {
    logger.warn(`captcha takeover gate: page content unavailable, gate skipped (${error instanceof Error ? error.message : 'unknown'})`);
    return null;
  }
  const takeover = classifyBrowserComputerManualTakeover(visibleText);
  // 只拦人机验证/风控与 MFA：login_required 的判据含裸「登录」字样，国内页面几乎都有登录入口，
  // 拦它会把普通点击全拖进审批（工单①口径：captcha / mfa / 风控）。登录墙交给主模型正常处理。
  if (!takeover || !GATED_TAKEOVER_CLASSES.has(takeover)) {
    return null;
  }
  const approved = await input.context.requestPermission({
    type: 'dangerous_command',
    tool: `browser_action.${input.action}`,
    forceConfirm: true,
    dangerLevel: 'danger',
    reason: '页面要求人机验证，需要你亲自完成',
    details: {
      action: input.action,
      takeoverClass: takeover,
      url,
    },
  });
  if (approved) {
    return null;
  }
  logger.warn(`captcha takeover gate: blocked "${input.action}" (class=${takeover}, url=${url})`);
  return {
    success: false,
    error: `页面命中人机验证/风控（${takeover}），变更动作 ${input.action} 已强制接管：请你在浏览器窗口亲自完成验证（可用 browser_action switch_tab 把标签页前置），完成后重试。`,
    metadata: {
      code: 'MANUAL_TAKEOVER_REQUIRED',
      userActionRequired: true,
      captchaClass: takeover,
      takeoverAction: 'browser_action.switch_tab',
    },
  };
}
