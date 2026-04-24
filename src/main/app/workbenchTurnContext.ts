import type { ConversationEnvelopeContext, WorkbenchToolScope } from '../../shared/contract/conversationEnvelope';
import type { AppServiceRunOptions } from '../../shared/contract/appService';
import { normalizeWorkbenchToolScope } from '../tools/workbenchToolScope';
import { getConnectorRegistry } from '../connectors';

function formatBrowserSnapshotTimestamp(timestamp?: number | null): string | null {
  if (!timestamp) {
    return null;
  }

  const value = new Date(timestamp);
  if (Number.isNaN(value.getTime())) {
    return null;
  }

  return value.toISOString();
}

export function buildWorkbenchTurnSystemContext(
  context?: ConversationEnvelopeContext,
): string[] {
  if (!context) {
    return [];
  }

  const lines: string[] = [];

  if (context.selectedSkillIds?.length) {
    lines.push(`优先考虑这些已挂载 skills（仅在相关时使用）：${context.selectedSkillIds.join('、')}`);
  }

  const readyConnectorIds = getReadySelectedConnectorIds(context.selectedConnectorIds);
  if (readyConnectorIds.length) {
    lines.push(`优先使用这些本地 connectors（仅在相关时使用）：${readyConnectorIds.join('、')}`);
  }

  if (context.selectedMcpServerIds?.length) {
    lines.push(`优先从这些 MCP servers 取工具或资源（仅在相关时使用）：${context.selectedMcpServerIds.join('、')}`);
  }

  if (context.executionIntent?.browserSessionMode === 'managed') {
    lines.push('本轮显式接入 Browser workbench：使用托管浏览器。需要网页自动化时，可优先走 browser_action 或 computer_use 的智能浏览器路径。');
  }

  if (context.executionIntent?.browserSessionMode === 'desktop') {
    lines.push('本轮显式接入 Browser workbench：绑定当前桌面浏览器上下文。优先参考当前 frontmost app、URL/title 和最近截图。');
    lines.push('如果桌面上下文未就绪，不要假设浏览器自动化可用；先说明缺少的权限或采集状态，再决定是否改走托管浏览器。');
  }
  if (context.executionIntent?.allowBrowserAutomation === false) {
    lines.push('本轮不要驱动托管浏览器自动化；除非明确改选 Managed，否则不要调用 browser_action 或 computer_use 的智能浏览器路径。');
  }

  const browserSessionSnapshot = context.executionIntent?.browserSessionSnapshot;
  if (browserSessionSnapshot?.preview?.title || browserSessionSnapshot?.preview?.url) {
    const title = browserSessionSnapshot.preview.title?.trim();
    const url = browserSessionSnapshot.preview.url?.trim();
    lines.push(`发送前 Browser session 预览：${title || '无标题'}${url ? ` · ${url}` : ''}`);
  }
  if (browserSessionSnapshot?.preview?.frontmostApp) {
    lines.push(`发送前 frontmost app：${browserSessionSnapshot.preview.frontmostApp}`);
  }
  if (browserSessionSnapshot?.preview?.surfaceMode) {
    lines.push(`发送前 workbench surface：${browserSessionSnapshot.preview.surfaceMode}`);
  }
  if (browserSessionSnapshot?.preview?.traceId) {
    lines.push(`最近 workbench trace：${browserSessionSnapshot.preview.traceId}`);
  }
  const screenshotTimestamp = formatBrowserSnapshotTimestamp(
    browserSessionSnapshot?.preview?.lastScreenshotAtMs,
  );
  if (screenshotTimestamp) {
    lines.push(`发送前最近截图时间：${screenshotTimestamp}`);
  }
  if (browserSessionSnapshot && !browserSessionSnapshot.ready && browserSessionSnapshot.blockedDetail) {
    lines.push(`当前 Browser workbench 未就绪：${browserSessionSnapshot.blockedDetail}`);
  }
  if (browserSessionSnapshot?.blockedHint) {
    lines.push(`修复提示：${browserSessionSnapshot.blockedHint}`);
  }

  if (lines.length === 0) {
    return [];
  }

  return [
    [
      '<turn_workbench_context>',
      '下面是用户为当前这一条消息显式选择的 workbench 偏好。',
      ...lines,
      '这些偏好只作用于当前 turn；如果与任务无关，不要强行使用，也不要在回复里机械复述这段说明。',
      '</turn_workbench_context>',
    ].join('\n'),
  ];
}

function isConnectorReadyForTurnScope(connectorId: string): boolean {
  const connector = getConnectorRegistry().get(connectorId);
  if (!connector) {
    return false;
  }

  const cachedStatus = connector.getCachedStatus?.();
  if (!cachedStatus) {
    return true;
  }

  if (cachedStatus.readiness) {
    return cachedStatus.connected && cachedStatus.readiness === 'ready';
  }

  return cachedStatus.connected;
}

function getReadySelectedConnectorIds(selectedConnectorIds?: string[]): string[] {
  return (selectedConnectorIds || [])
    .map((connectorId) => connectorId.trim())
    .filter(Boolean)
    .filter(isConnectorReadyForTurnScope);
}

export function buildWorkbenchToolScope(
  context?: ConversationEnvelopeContext,
): WorkbenchToolScope | undefined {
  return normalizeWorkbenchToolScope({
    allowedSkillIds: context?.selectedSkillIds,
    allowedConnectorIds: getReadySelectedConnectorIds(context?.selectedConnectorIds),
    allowedMcpServerIds: context?.selectedMcpServerIds,
  });
}

export function withWorkbenchTurnSystemContext(
  options: AppServiceRunOptions | undefined,
  context?: ConversationEnvelopeContext,
): AppServiceRunOptions | undefined {
  const turnSystemContext = buildWorkbenchTurnSystemContext(context);
  const workbenchToolScope = buildWorkbenchToolScope(context);
  const toolScope = normalizeWorkbenchToolScope({
    allowedSkillIds: [
      ...(options?.toolScope?.allowedSkillIds || []),
      ...(workbenchToolScope?.allowedSkillIds || []),
    ],
    allowedConnectorIds: [
      ...(options?.toolScope?.allowedConnectorIds || []),
      ...(workbenchToolScope?.allowedConnectorIds || []),
    ],
    allowedMcpServerIds: [
      ...(options?.toolScope?.allowedMcpServerIds || []),
      ...(workbenchToolScope?.allowedMcpServerIds || []),
    ],
  });
  if (turnSystemContext.length === 0 && !toolScope && !context?.executionIntent) {
    return options;
  }

  return {
    ...(options || {}),
    ...(turnSystemContext.length > 0 ? { turnSystemContext } : {}),
    ...(toolScope ? { toolScope } : {}),
    ...(context?.executionIntent ? { executionIntent: { ...context.executionIntent } } : {}),
  };
}
