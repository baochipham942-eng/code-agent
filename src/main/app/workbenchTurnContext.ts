import type { ConversationEnvelopeContext, WorkbenchToolScope } from '../../shared/contract/conversationEnvelope';
import type { SelectedElementInfo } from '../../shared/livePreview/protocol';
import type { AppServiceRunOptions } from '../../shared/contract/appService';
import { normalizeDesignBrief } from '../../shared/contract/designBrief';
import type { DesignBrief } from '../../shared/contract/designBrief';
import { directionTokens } from '../../design/direction-tokens';
import { readDesignMdSummary } from '../../design/design-md-loader';
import { getActiveBrandSync } from '../services/design/brandRegistry';
import { brandContractToBriefProjection } from '../../shared/contract/brandContract';
import { normalizeWorkbenchToolScope } from '../tools/workbenchToolScope';
import { getConnectorRegistry } from '../connectors';
import { buildSelfCritiquePromptSection } from '../prompts/selfCritique';

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

const BROWSER_ROUTING_CONTRACT_LINES = [
  'Browser routing contract：纯阅读、单 URL 摘要、内容抽取或链接汇总，优先选择轻量读取/搜索/抓取工具；不要仅因出现 URL 就启动 Browser/Computer。',
  '只有需要登录态、表单填写、按钮点击、下载/上传、多页跳转、动态页面状态、截图或视觉验证时，才推荐 Browser workbench。',
];

const DESKTOP_ACTION_CONTRACT_LINES = [
  'Desktop action contract：任何 macOS 桌面点击/输入/滚动前，必须先确认权限、目标前台窗口或后台 target app、最近快照，以及坐标/locator 来源。',
  '桌面坐标动作必须来自 observe/screenshot/窗口候选等可解释证据；后台 AX 用 get_ax_elements/locate_role 返回的 axPath，后台 CGEvent 用 get_windows 返回的 pid/windowId/windowRef/windowLocalPoint。',
  '如果权限、前台窗口、快照或坐标来源不足，返回明确 blocked reason 和下一步读取动作；动作执行后先 re-observe，再声称最终桌面状态。',
];

export function buildWorkbenchTurnSystemContext(
  context?: ConversationEnvelopeContext,
): string[] {
  if (!context) {
    return [];
  }

  const lines: string[] = [];
  const designBrief = buildDesignBriefPromptPayload(context);
  if (designBrief) {
    lines.push('<design_brief_json>');
    lines.push(designBrief);
    lines.push('</design_brief_json>');
    const selfCritique = buildSelfCritiquePromptSection(context?.designBrief);
    if (selfCritique) {
      lines.push(selfCritique);
    }
  }

  if (context.selectedSkillIds?.length) {
    lines.push(`优先考虑这些已挂载 skills（仅在相关时使用）：${context.selectedSkillIds.join('、')}`);
  }

  if (context.turnCapabilityScopeMode === 'manual') {
    lines.push('本轮能力范围由用户手动选择；只在相关时使用已选能力，不要因为处于 Manual 就强行调用。');
  }

  const readyConnectorIds = getReadySelectedConnectorIds(context.selectedConnectorIds);
  if (readyConnectorIds.length) {
    lines.push(`优先使用这些本地 connectors（仅在相关时使用）：${readyConnectorIds.join('、')}`);
  }

  if (context.selectedMcpServerIds?.length) {
    lines.push(`优先从这些 MCP servers 取工具或资源（仅在相关时使用）：${context.selectedMcpServerIds.join('、')}`);
  }

  if (!context.executionIntent?.browserSessionMode && (context.selectedSkillIds?.length || context.selectedMcpServerIds?.length)) {
    lines.push(...BROWSER_ROUTING_CONTRACT_LINES);
  }

  if (context.runtimeInput?.mode === 'supplement') {
    lines.push('这条消息是用户在 agent 运行过程中的补充指令：把它纳入当前任务和已有计划，除非内容明确要求改方向，不要把它当成全新任务。');
  }

  if (context.runtimeInput?.mode === 'redirect') {
    lines.push('这条消息是用户显式选择的改道指令：停止沿用当前思路，按这条新要求重组接下来的执行。');
  }

  if (context.executionIntent?.browserSessionMode === 'managed') {
    lines.push('本轮显式接入 Browser workbench：使用托管浏览器。需要登录态、表单、点击、多页跳转、下载/上传、动态状态或截图验证时，可走 browser_action 或 computer_use 的智能浏览器路径。');
    lines.push(...BROWSER_ROUTING_CONTRACT_LINES);
  }

  if (context.executionIntent?.browserSessionMode === 'desktop') {
    lines.push('本轮显式接入 Browser workbench：绑定当前桌面浏览器上下文。优先参考当前 frontmost app、URL/title 和最近截图。');
    lines.push('如果桌面上下文未就绪，不要假设浏览器自动化可用；先说明缺少的权限或采集状态，再决定是否改走托管浏览器。');
    lines.push(...BROWSER_ROUTING_CONTRACT_LINES);
    lines.push(...DESKTOP_ACTION_CONTRACT_LINES);
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

  lines.push(...buildVoiceInputPromptLines(context));

  const livePreviewSelectionLines = buildLivePreviewSelectionPromptLines(context.livePreviewSelection);
  lines.push(...livePreviewSelectionLines);

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

function buildVoiceInputPromptLines(context: ConversationEnvelopeContext): string[] {
  const voiceInput = context.voiceInput;
  if (!voiceInput) {
    return [];
  }

  const detail: string[] = [
    '这条用户消息由会话页语音输入转写进入 composer，用户可能已经编辑过转写文本。',
  ];
  if (voiceInput.language) {
    detail.push(`- ASR 识别语言：${voiceInput.language}`);
  }
  if (voiceInput.transcriptionMode || voiceInput.asrEngine) {
    detail.push(`- 转写引擎：${voiceInput.transcriptionMode || 'unknown'}${voiceInput.asrEngine ? ` / ${voiceInput.asrEngine}` : ''}`);
  }
  if (voiceInput.model) {
    detail.push(`- ASR 模型：${voiceInput.model}`);
  }
  if (voiceInput.audioDurationSeconds !== undefined) {
    detail.push(`- 语音时长：${voiceInput.audioDurationSeconds}s`);
  }
  if (voiceInput.chunkCount && voiceInput.chunkCount > 1) {
    detail.push(`- 长语音已分段转写：${voiceInput.chunkCount} 段`);
  }
  if (voiceInput.postProcessed) {
    detail.push('- 转写文本已做轻量整理，原始转写长度已记录在 metadata。');
  }

  return [
    '<voice_input_context>',
    ...detail,
    '回复语言指引：如果用户没有明确要求其他语言，优先沿用 ASR 识别语言或转写文本显著呈现的语言；不要把明显口误、停顿词或转写噪音当成用户指令。',
    '</voice_input_context>',
  ];
}

// 定点反馈 loop（locality-anchored feedback）：把用户在 Live Preview 里圈选的
// 渲染元素注入 turn context，引导模型用 visual_edit 定向迭代。选区由 composer 侧
// readActiveLivePreviewSelection() 随 envelope 带出，main 侧在这里消费（此前 envelope
// 字段是死数据，模型看不到用户圈选了什么）。
function buildLivePreviewSelectionPromptLines(
  selection?: SelectedElementInfo | null,
): string[] {
  if (!selection?.location?.file || !selection.location.line) {
    return [];
  }

  const { file, line, column } = selection.location;
  const detail: string[] = [
    `- 源文件（绝对路径）：${file}`,
    `- 行号：${line}${column ? `  列号：${column}` : ''}`,
  ];
  if (selection.tag) {
    detail.push(`- DOM 标签：<${selection.tag}>${selection.componentName ? `  组件：${selection.componentName}` : ''}`);
  } else if (selection.componentName) {
    detail.push(`- 组件：${selection.componentName}`);
  }
  const text = selection.text?.trim();
  if (text) {
    // 截断避免长文本元素把 prompt 撑爆
    detail.push(`- 可见文本：${text.length > 160 ? `${text.slice(0, 160)}…` : text}`);
  }

  return [
    '<live_preview_selection>',
    '用户在 Live Preview 里圈选了一个渲染后的元素，本轮消息是针对它的定点反馈。',
    ...detail,
    '路由指引：用 visual_edit 工具做定向修改，file/line 直接用上面给的值，userIntent = 用户这条消息的诉求。',
    '这是局部锚定反馈——只改这个元素相关的代码，不要全局重写、不要顺手改别的地方。',
    '如果用户这条消息与圈选元素明显无关（例如在问别的问题），忽略本段。',
    '</live_preview_selection>',
  ];
}

function buildDesignBriefPromptPayload(context?: ConversationEnvelopeContext): string | null {
  if (!context?.designBrief) {
    return null;
  }

  const brief = enrichDesignBriefForPrompt(context.designBrief, context.workingDirectory);
  if (!brief) {
    return null;
  }

  return JSON.stringify(brief, null, 2);
}

function enrichDesignBriefForPrompt(
  brief: DesignBrief,
  workingDirectory?: string | null,
): DesignBrief | undefined {
  const references = [...(brief.references || [])];
  const designMdSummary = workingDirectory ? readDesignMdSummary(workingDirectory) : null;
  if (designMdSummary && !references.some((item) => item === designMdSummary || item.startsWith('DESIGN.md:'))) {
    references.push(designMdSummary);
  }

  // 我的品牌契约强制注入（CD-Parity §1）：active 品牌是「sticky 默认」——
  //  · directionTokens：仅当 brief 既无显式 directionTokens 也无 direction 时，用品牌 tokens 兜底；
  //    用户在本任务里显式选了方向/带了 tokens，则方向优先（per-task 胜出）。
  //  · brandContract（keep/change/doNotCopy）：品牌的「不要这样」约束永远生效——
  //    仅当 brief 自身未携带 brandContract 时，才并入 active 品牌的三桶约束。
  const activeBrand = getActiveBrandSync();
  const hasExplicitTokens = Boolean(brief.directionTokens || brief.direction);
  const directionTokensResolved =
    brief.directionTokens
    || (brief.direction ? directionTokens[brief.direction] : undefined)
    || (activeBrand && !hasExplicitTokens ? activeBrand.tokens : undefined);
  const brandContractResolved =
    brief.brandContract
    || (activeBrand ? brandContractToBriefProjection(activeBrand) : undefined);

  return normalizeDesignBrief({
    ...brief,
    references,
    directionTokens: directionTokensResolved,
    brandContract: brandContractResolved,
  });
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
  if (
    turnSystemContext.length === 0
    && !toolScope
    && !context?.preferredAgentId
    && !context?.executionIntent
    && !context?.runtimeInput
  ) {
    return options;
  }

  return {
    ...(options || {}),
    ...(context?.preferredAgentId ? { agentOverrideId: context.preferredAgentId } : {}),
    ...(turnSystemContext.length > 0 ? { turnSystemContext } : {}),
    ...(toolScope ? { toolScope } : {}),
    ...(context?.executionIntent ? { executionIntent: { ...context.executionIntent } } : {}),
    ...(context?.runtimeInput ? { runtimeInput: { ...context.runtimeInput } } : {}),
  };
}
