// keep_result_page — N-BROWSER-KEEP-RESULT-PAGE（借鉴 ego S-09 "keep only the
// result Page for the user"）。
//
// 模型显式声明「当前活跃页就是交给用户的结果页」：关掉其余标签页，把当前 binding
// 标记为会话的 kept 结果窗（run 结束不关窗，用户从聊天里认领继续操作）。
// 拒绝面（各回一句大白话，不抛码）：Relay 引擎、个人档案 run、无人值守/定时 run。

import type { ToolContext, ToolExecutionResult } from '../types';
import { getPermissionModeManager } from '../../permissions/modes';
import {
  getManagedBrowserProviderAdapter,
  MANAGED_BROWSER_USER_PERSONAL_SERVICE_KEY,
  type ManagedBrowserProviderAdapter,
} from '../../services/surfaceExecution/ManagedBrowserProviderAdapter';
import type { SurfaceRuntimeIdentityV1 } from '../../services/surfaceExecution/SurfaceExecutionRuntime';

interface KeepResultPageBrowserService {
  listTabs(): Array<{ id: string; url: string; title: string }>;
  getActiveTab(): { id: string; url: string; title: string } | null;
  closeTab(tabId: string): Promise<void>;
}

export interface KeepResultPageInput {
  identity: SurfaceRuntimeIdentityV1 | null;
  browserService: KeepResultPageBrowserService;
  context: Pick<ToolContext, 'sessionId'>;
  params: Record<string, unknown>;
  adapter?: Pick<ManagedBrowserProviderAdapter, 'markResultPageKept' | 'getBinding'>;
}

function refuse(reason: string): ToolExecutionResult {
  return { success: false, error: reason, metadata: { code: 'KEEP_RESULT_PAGE_REFUSED' } };
}

export async function executeKeepResultPage(input: KeepResultPageInput): Promise<ToolExecutionResult> {
  const adapter = input.adapter ?? getManagedBrowserProviderAdapter();

  // Relay 引擎：用户自己 Chrome 里的标签页不是 Neo 的窗，没有「留给用户」语义。
  if (input.params.engine === 'relay') {
    return refuse('keep_result_page is not available for the relay engine. Relay drives one of the user\'s own Chrome tabs, which stays with the user anyway.');
  }
  // 无人值守/定时 run：没有在场用户来认领这扇窗，kept 只会白占一个池位。
  const sessionId = input.context.sessionId;
  if (sessionId && getPermissionModeManager().isUnattendedSession(sessionId)) {
    return refuse('keep_result_page is not available for unattended or scheduled runs; no one is there to pick the page up. Finish the task with a screenshot or the result URL instead.');
  }
  // 旧调用方没有完整 surface 身份：无法定位 binding，无从 keep。
  if (!input.identity) {
    return refuse('keep_result_page requires a managed browser session bound to this run.');
  }

  const binding = adapter.getBinding(input.identity);
  if (!binding) {
    return refuse('No managed browser session is bound to this run. Open the result page with browser_action first, then call keep_result_page.');
  }
  if (binding.serviceKey === MANAGED_BROWSER_USER_PERSONAL_SERVICE_KEY) {
    return refuse('This run shares the personal browser profile, so its window cannot be kept as a result page. Finish the task and give the user the result URL instead.');
  }

  const activeTab = input.browserService.getActiveTab();
  if (!activeTab) {
    return refuse('No active tab to keep. Navigate to the result page first.');
  }

  // 关掉除活跃页外的所有标签页——结果窗只留结果这一页。
  const otherTabs = input.browserService.listTabs().filter((tab) => tab.id !== activeTab.id);
  for (const tab of otherTabs) {
    await input.browserService.closeTab(tab.id);
  }

  const kept = adapter.markResultPageKept(input.identity, {
    url: activeTab.url,
    title: activeTab.title || '',
  });
  if (!kept.ok) {
    return refuse(kept.reason);
  }

  return {
    success: true,
    output: `Result page kept for the user: ${activeTab.title || activeTab.url} (${activeTab.url}). `
      + `${otherTabs.length} other tab(s) closed. After this run ends the user can open and keep working on this exact page from the chat.`,
  };
}
