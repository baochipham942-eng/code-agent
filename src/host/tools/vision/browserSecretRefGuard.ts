// ============================================================================
// browser_action `type` + secretRef guard (N-BROWSER-SECRETREF-HARDEN)
// 1. 只解析 CODE_AGENT_BROWSER_SECRET_* 环境变量；`<NAME>_ORIGINS` 是站点白名单，缺失即拒绝。
// 2. 填充前核对页面实时 origin；不在白名单（含跳到第三方 IdP）则什么都不填，交还给用户。
// 3. 填充失败只返回本模块自己的句子：Playwright 报错会引用调用参数（即密码），绝不透传。
// ============================================================================

import type { ToolExecutionResult } from '../types';
import { BROWSER_SECRET_ENV_PREFIX, BROWSER_SECRET_ORIGINS_SUFFIX } from '../../../shared/constants';
import { createLogger } from '../../services/infra/logger';
import type { BrowserTargetRef } from '../../services/infra/browser/types';
import {
  formatBrowserTargetRefLabel,
  getBrowserTargetRefErrorDetails,
  summarizeBrowserTargetRefForTool,
  summarizeSecretRef,
} from './browserActionResultProjection';

const logger = createLogger('BrowserSecretRefGuard', { lane: 'browser' });

const HOW_TO_CONFIGURE =
  `Add ${BROWSER_SECRET_ENV_PREFIX}<NAME>=<value> and ${BROWSER_SECRET_ENV_PREFIX}<NAME>${BROWSER_SECRET_ORIGINS_SUFFIX}=https://site.example ` +
  'to ~/.code-agent/.env, then reference it as secretRef "env:' + BROWSER_SECRET_ENV_PREFIX + '<NAME>".';

type SecretResolution =
  | { ok: true; value: string; originsVar: string; allowedOrigins: string | undefined }
  | { ok: false; result: ToolExecutionResult };

function fail(error: string, metadata?: Record<string, unknown>): ToolExecutionResult {
  return { success: false, error, ...(metadata ? { metadata } : {}) };
}

export function resolveSecret(secretRef: string): SecretResolution {
  const name = secretRef.startsWith('env:') ? secretRef.slice(4) : '';
  const valid =
    /^[A-Z0-9_]+$/.test(name) &&
    name.startsWith(BROWSER_SECRET_ENV_PREFIX) &&
    name.length > BROWSER_SECRET_ENV_PREFIX.length &&
    !name.endsWith(BROWSER_SECRET_ORIGINS_SUFFIX);
  if (!valid) {
    return {
      ok: false,
      result: fail(
        `secretRef is not allowed: only env:${BROWSER_SECRET_ENV_PREFIX}* variables can be used (names ending in ${BROWSER_SECRET_ORIGINS_SUFFIX} hold the allowed sites, not secrets). ${HOW_TO_CONFIGURE}`,
      ),
    };
  }
  const value = process.env[name];
  if (!value) {
    return {
      ok: false,
      result: fail(`secretRef variable ${name} is not set. Nothing was typed. ${HOW_TO_CONFIGURE}`),
    };
  }
  const originsVar = `${name}${BROWSER_SECRET_ORIGINS_SUFFIX}`;
  return { ok: true, value, originsVar, allowedOrigins: process.env[originsVar] };
}

function originOf(url: string): string | null {
  try {
    const origin = new URL(url).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

export function checkOrigin(currentUrl: string, allowedOriginsEnv: string | undefined): boolean {
  const current = originOf(currentUrl);
  if (!current || !allowedOriginsEnv) return false;
  return allowedOriginsEnv
    .split(',')
    .map((entry) => originOf(entry.trim()))
    .some((origin) => origin === current);
}

/** Outer-catch belt and braces: strip the resolved secret from any message about to be logged/returned. */
export function scrubSecretFromMessage(message: string, secretRef: string | undefined): string {
  if (!secretRef) return message;
  const resolved = resolveSecret(secretRef);
  return resolved.ok ? message.split(resolved.value).join('[secret]') : message;
}

type FailureCategory = 'not editable' | 'timeout' | 'stale ref' | 'other';

function categorize(error: unknown): FailureCategory {
  if (getBrowserTargetRefErrorDetails(error)) return 'stale ref';
  const message = error instanceof Error ? error.message : '';
  if (/not editable|not an <input>|disabled|readonly|read-only|not fillable/i.test(message)) return 'not editable';
  if (/timeout/i.test(message)) return 'timeout';
  return 'other';
}

const CATEGORY_NEXT_STEP: Record<FailureCategory, string> = {
  'not editable': 'The element is not a text field you can type into (it may be disabled or read-only). Run browser_action.get_dom_snapshot and pick the real input.',
  timeout: 'The element did not become ready in time. Check that the page finished loading and the element is visible, then retry.',
  'stale ref': 'The targetRef no longer matches the page. Run browser_action.get_dom_snapshot and retry with a fresh targetRef.',
  other: 'Run browser_action.get_dom_snapshot to check the page state, then retry.',
};

export interface SecretTypeBrowser {
  getLiveTabUrl?(tabId?: string): string;
  getActiveTab(): { url: string; page?: { url?: () => string } } | null;
  getElementBoundingBox(selector: string, tabId?: string): Promise<unknown>;
  type(selector: string, text: string, tabId?: string): Promise<void>;
  typeTargetRef(targetRef: unknown, text: string, tabId?: string): Promise<BrowserTargetRef>;
}

export interface SecretTypeInput {
  browserService: SecretTypeBrowser;
  secretRef: string;
  targetRef?: unknown;
  selector?: string;
  tabId?: string;
}

function currentUrl(browser: SecretTypeBrowser, tabId?: string): string {
  if (typeof browser.getLiveTabUrl === 'function') return browser.getLiveTabUrl(tabId);
  const tab = browser.getActiveTab();
  return tab?.page?.url?.() ?? tab?.url ?? '';
}

function refLabel(targetRef: unknown): string {
  if (typeof targetRef === 'string') return targetRef;
  const refId = (targetRef as { refId?: unknown } | null)?.refId;
  return typeof refId === 'string' ? refId : 'targetRef';
}

export async function typeSecret(input: SecretTypeInput): Promise<ToolExecutionResult> {
  const { browserService, secretRef, targetRef, selector, tabId } = input;
  const secretLabel = summarizeSecretRef(secretRef);
  const resolved = resolveSecret(secretRef);
  if (!resolved.ok) return resolved.result;
  if (!targetRef && !selector) return fail('selector or targetRef required for type');

  const refTabId = tabId ?? (typeof targetRef === 'object' && targetRef ? (targetRef as { tabId?: string }).tabId : undefined);
  let url = '';
  try {
    url = currentUrl(browserService, refTabId);
  } catch {
    // unreadable page => treated as mismatch below
  }
  if (!checkOrigin(url, resolved.allowedOrigins)) {
    const origin = originOf(url) ?? 'an unknown origin';
    logger.warn(`secretRef origin refused (origin=${origin}, allowListSet=${Boolean(resolved.allowedOrigins)})`);
    const reason = resolved.allowedOrigins
      ? `the page is on ${origin}, which is not listed in ${resolved.originsVar}`
      : `${resolved.originsVar} is not set, so no site is allowed for this secret`;
    return fail(
      `This step needs you: ${reason}. Nothing was typed. Enter the credential yourself in the browser window (browser_action.switch_tab brings it to the front)` +
        `, or add the exact site origin to ${resolved.originsVar} if you trust it.`,
      {
        code: 'SECRET_REF_ORIGIN_MISMATCH',
        userActionRequired: true,
        origin,
        allowListConfigured: Boolean(resolved.allowedOrigins),
      },
    );
  }

  const target = targetRef ? `targetRef ${refLabel(targetRef)}` : `selector ${selector}`;
  try {
    if (targetRef) {
      const filled = await browserService.typeTargetRef(targetRef, resolved.value, tabId);
      return {
        success: true,
        output: `Typed secretRef ${secretLabel} into targetRef: ${formatBrowserTargetRefLabel(filled)}`,
        metadata: { targetRef: summarizeBrowserTargetRefForTool(filled), secretRef: secretLabel },
      };
    }
    const boundingBox = await browserService.getElementBoundingBox(selector as string, tabId);
    await browserService.type(selector as string, resolved.value, tabId);
    return {
      success: true,
      output: `Typed secretRef ${secretLabel} into ${selector}`,
      metadata: { secretRef: secretLabel, pointerTarget: { label: selector, selector, boundingBox } },
    };
  } catch (error) {
    const category = categorize(error);
    logger.warn(`secretRef type failed (category=${category})`);
    return fail(`Could not type secretRef into ${target}: ${category}. ${CATEGORY_NEXT_STEP[category]}`, {
      code: 'SECRET_REF_TYPE_FAILED',
      category,
    });
  }
}
