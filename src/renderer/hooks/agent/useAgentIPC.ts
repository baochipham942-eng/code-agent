// useAgentIPC owns send/cancel IPC calls and direct-routing metadata.
import { useCallback, type MutableRefObject } from 'react';
import { generateMessageId } from '@shared/utils/id';
import type { Message } from '@shared/contract';
import type {
  ConversationEnvelope,
  ConversationEnvelopeContext,
  RuntimeInputMode,
  WorkbenchMessageMetadata,
} from '@shared/contract/conversationEnvelope';
import type { MessageMetadata } from '@shared/contract/message';
import type { SteerOrQueueOutcome } from '@shared/contract/appService';
import { normalizeDesignBrief, type DesignBrief } from '@shared/contract/designBrief';
import {
  formatDesignAcceptanceContractForPrompt,
  type DesignAcceptanceContract,
} from '@shared/contract/designAcceptanceContract';
import { DESIGN_CODE_HANDOFF } from '@shared/constants/designHandoff';
import {
  formatDesignCodeHandoffForPrompt,
  normalizeDesignCodeHandoffContext,
  type DesignCodeHandoffContext,
  type DesignCodeHandoffVariant,
} from '@shared/contract/designHandoff';
import { directionTokens } from '@/design/direction-tokens';
import { IPC_CHANNELS, IPC_DOMAINS } from '@shared/ipc';
import { VoiceSchemas } from '@shared/ipc/schemas';
import type { SwarmAgentState } from '@shared/contract/swarm';
import { createLogger } from '../../utils/logger';
import { useAppStore } from '../../stores/appStore';
import { useDesignCanvasStore } from '../../components/design/designCanvasStore';
import { isDesignCanvasActiveForSession } from '../../components/design/designCanvasSessionGate';
import { buildCanvasSnapshot } from '../../components/design/buildCanvasSnapshot';
import { isReferenceNode, isVideoNode, type CanvasNode } from '../../components/design/designCanvasTypes';
import { useSessionStore } from '../../stores/sessionStore';
import { useSwarmStore } from '../../stores/swarmStore';
import { useTaskStore, type SessionStatus as TaskSessionStatus } from '../../stores/taskStore';
import { useVoiceCallStore } from '../../stores/voiceCallStore';
import { useTurnExecutionStore } from '../../stores/turnExecutionStore';
import ipcService from '../../services/ipcService';
import { typedInvokeDomain } from '../../services/typedInvoke';

const logger = createLogger('useAgent');

/**
 * Direct routing 目前不走 AppService 的 turnSystemContext，所以仍需要把 brief
 * prepend 到发送给目标 agent 的隐藏内容里。普通/interrupt 路径会走 context.designBrief。
 */
function formatDesignBriefReminder(brief: DesignBrief): string {
  const lines = [
    '<system-reminder kind="design-brief-json">',
    '当前会话已锁定 design brief，按此结构化 JSON 直接出 artifact，不要再 emit question-form。',
  ];
  if (brief.referenceScreenshot) {
    lines.push(
      '用户选择「匹配参考截图」模式：请查看用户在本轮附带的参考截图，从图中提取配色/字体/版式/间距并尽力复刻，而不是套用预设方向。',
    );
  }
  lines.push(JSON.stringify(brief, null, 2), '</system-reminder>');
  return lines.join('\n');
}

function applyDesignBriefToContent(content: string, brief: DesignBrief | undefined): string {
  if (!brief) return content;
  const reminder = formatDesignBriefReminder(brief);
  return `${reminder}\n\n${content}`;
}

function formatDesignAcceptanceContractReminder(contract: DesignAcceptanceContract): string | null {
  const payload = formatDesignAcceptanceContractForPrompt(contract);
  if (!payload) return null;
  return [
    '<system-reminder kind="design-acceptance-contract-json">',
    '当前 turn 携带验收/约束契约：这是给 agent 收敛产物的隐藏意图，用于自检、QA 修复和 handoff，不要把它当成给用户看的开发规格。',
    payload,
    '</system-reminder>',
  ].join('\n');
}

/**
 * R1（设计 Surface 会话化）冷启动引导：设计会话激活时（即使画布空），给 agent prepend 一段
 * <system-reminder>，明确告诉它用 ProposeCanvasOps / RequestDesignAutonomy 操作画布，
 * 别用 shell / python / 写文件等方式绕开画布。修补 dogfood 暴露的缺口——空画布不注入
 * canvasSnapshot，系统提示零引导，agent 不知道该走画布工具。
 */
export function formatDesignCanvasSessionReminder(canvasEmpty: boolean): string {
  const canvasState = canvasEmpty ? '为空' : '已有元素';
  return [
    '<system-reminder kind="design-canvas-session">',
    `你正在一个「设计画布」协作会话中，右侧画布是与用户共同迭代的产物面（画布当前${canvasState}）。`,
    '要在画布上创建或修改任何视觉内容（生成图片、添加/排布节点、连线、标注、出多个变体等），必须调用 ProposeCanvasOps 工具提议画布操作，由用户在画布上审批后落地；需要一次性产出多个变体供用户挑选时用 RequestDesignAutonomy。',
    '严禁用 shell / python / 写文件等方式生成图片或绕开画布——画布是本会话唯一的视觉产物面。',
    '</system-reminder>',
  ].join('\n');
}

function applyDesignAcceptanceContractToContent(
  content: string,
  contract: DesignAcceptanceContract | undefined,
): string {
  if (!contract) return content;
  const reminder = formatDesignAcceptanceContractReminder(contract);
  return reminder ? `${reminder}\n\n${content}` : content;
}

function formatDesignCodeHandoffReminder(handoff: DesignCodeHandoffContext): string | null {
  const payload = formatDesignCodeHandoffForPrompt(handoff);
  if (!payload) return null;
  return [
    '<system-reminder kind="design-code-handoff-json">',
    'Design->Code handoff uses B model: code stays hidden, Preview QA closes fidelity, and the user judges the running artifact.',
    'Use the selected variant, absolute canvas layout, acceptance contract, locked regions, brand refs, and QA evidence as hidden implementation intent.',
    payload,
    '</system-reminder>',
  ].join('\n');
}

function applyDesignCodeHandoffToContent(
  content: string,
  handoff: DesignCodeHandoffContext | undefined,
): string {
  if (!handoff) return content;
  const reminder = formatDesignCodeHandoffReminder(handoff);
  return reminder ? `${reminder}\n\n${content}` : content;
}

/**
 * 设计会话冷启动引导的判定 + 应用。与 withCanvasSnapshotContext 同口径双闸
 * （isSessionDesignActive + 画布属主==当前会话），但**不要求画布非空**——空画布才是真缺口。
 * 命中则把引导 prepend 到 content 前；否则原样返回。
 */
export function applyDesignCanvasSessionToContent(content: string, sessionId: string | null | undefined): string {
  if (!isDesignCanvasActiveForSession(sessionId)) return content;
  const cs = useDesignCanvasStore.getState();
  const reminder = formatDesignCanvasSessionReminder(cs.nodes.length === 0);
  return `${reminder}\n\n${content}`;
}

function enrichDesignBrief(brief: DesignBrief | undefined): DesignBrief | undefined {
  if (!brief) return undefined;
  return normalizeDesignBrief({
    ...brief,
    directionTokens: brief.directionTokens || (brief.direction ? directionTokens[brief.direction] : undefined),
  });
}

function withDesignBriefContext(
  context: ConversationEnvelopeContext | undefined,
  brief: DesignBrief | undefined,
): ConversationEnvelopeContext | undefined {
  if (!brief) return context;
  return {
    ...(context || {}),
    designBrief: brief,
  };
}

// ADR-026 D1-B：design 模式发轮时附带画布快照，供 agent ProposeCanvasOps 引用真实节点 id。
// R1（设计 Surface 会话化）：双闸守护，避免跨会话泄漏画布——
//   ① per-session 设计激活闸：当前 session 必须 isSessionDesignActive（不污染普通编码会话）；
//   ② 画布属主闸：全局单例画布 store 不随 switchSession 重载，故还须校验画布属主==当前会话，
//      否则会把上一个设计会话的画布误注入当前会话的 agent 上下文（fail-closed）。
// 两闸都过且画布非空时才附带（避免无谓 prompt 膨胀）；运行时态，不进 DB。
export function withCanvasSnapshotContext(
  context: ConversationEnvelopeContext | undefined,
): ConversationEnvelopeContext | undefined {
  const sessionId = useSessionStore.getState().currentSessionId;
  if (!isDesignCanvasActiveForSession(sessionId)) return context;
  const cs = useDesignCanvasStore.getState();
  if (cs.nodes.length === 0) return context;
  const canvasSnapshot = buildCanvasSnapshot({ nodes: cs.nodes, connectors: cs.connectors, shapes: cs.shapes });
  if (canvasSnapshot.nodes.length === 0) return context;
  return { ...(context || {}), canvasSnapshot };
}

/**
 * R1（设计 Surface 会话化）跨进程硬控闸：设计会话激活时，在 envelope 的
 * executionIntent 上打 designCanvasActive=true，main 侧据此：① inference 把画布工具
 * （ProposeCanvasOps/Video/Slides）提进工具表 + 停用通用媒介工具；② shell 工具硬拦
 * "用代码画图"（Python/Pillow/imagemagick 等）并重定向到 ProposeCanvasOps；③ 按轮注入
 * 设计画布会话引导。闸口径与画布注入/affordance 完全一致（isSessionDesignActive + 画布属主==
 * 当前会话），严守"只在设计会话生效，绝不伤普通会话"——非激活时显式置 false。
 * **合并语义**：保留 executionIntent 上已有字段（browserSessionMode 等），只补 designCanvasActive。
 */
export function withDesignCanvasActiveIntent(
  context: ConversationEnvelopeContext | undefined,
  sessionId: string | null | undefined,
): ConversationEnvelopeContext | undefined {
  const active = isDesignCanvasActiveForSession(sessionId);
  return {
    ...(context || {}),
    executionIntent: {
      ...(context?.executionIntent || {}),
      designCanvasActive: active,
    },
  };
}

function compactSourcePath(runDir: string | null, src: string): string {
  if (!runDir || src.startsWith('/') || /^[a-z]+:\/\//i.test(src)) return src;
  return `${runDir.replace(/\/+$/, '')}/${src.replace(/^\/+/, '')}`;
}

function handoffLabelForNode(node: CanvasNode): string | undefined {
  const label = node.label?.trim() || node.prompt?.trim();
  return label ? label.slice(0, DESIGN_CODE_HANDOFF.MAX_TEXT_CHARS) : undefined;
}

function pickHandoffNodes(nodes: CanvasNode[], selectedIds: readonly string[]): CanvasNode[] {
  const liveOutputs = nodes.filter((node) => !node.discarded && !isReferenceNode(node));
  const byId = new Map(liveOutputs.map((node) => [node.id, node]));
  const selected = selectedIds
    .map((id) => byId.get(id))
    .filter((node): node is CanvasNode => Boolean(node));
  if (selected.length > 0) return selected.slice(0, DESIGN_CODE_HANDOFF.MAX_SELECTED_VARIANTS);

  const chosen = liveOutputs.filter((node) => node.chosen);
  if (chosen.length > 0) return chosen.slice(0, DESIGN_CODE_HANDOFF.MAX_SELECTED_VARIANTS);

  const latest = [...liveOutputs].sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))[0];
  return latest ? [latest] : [];
}

function handoffVariantFromNode(
  node: CanvasNode,
  runDir: string | null,
  prior?: DesignCodeHandoffVariant,
): DesignCodeHandoffVariant {
  const variant: DesignCodeHandoffVariant = {
    id: node.id,
    mediaType: isVideoNode(node) ? 'video' : 'image',
    sourcePath: compactSourcePath(runDir, node.src),
    chosen: node.chosen === true,
    bounds: {
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      coordinateSpace: 'canvas_absolute',
    },
  };
  const label = handoffLabelForNode(node);
  if (label) variant.label = label;
  if (prior?.interactionStates?.length) {
    variant.interactionStates = prior.interactionStates;
  }
  return variant;
}

export function buildDesignCodeHandoffContextFromCanvas(
  context: ConversationEnvelopeContext | undefined,
): DesignCodeHandoffContext | undefined {
  const existing = normalizeDesignCodeHandoffContext(context?.designCodeHandoff);
  const canvas = useDesignCanvasStore.getState();
  const nodes = pickHandoffNodes(canvas.nodes, canvas.selectedIds);
  if (nodes.length === 0) return existing;

  const priorById = new Map(existing?.selectedVariants.map((variant) => [variant.id, variant]) ?? []);
  return normalizeDesignCodeHandoffContext({
    ...(existing || {}),
    selectedVariants: nodes.map((node) => handoffVariantFromNode(node, canvas.runDir, priorById.get(node.id))),
    acceptanceContract: context?.designAcceptanceContract ?? existing?.acceptanceContract,
    canvasSnapshot: context?.canvasSnapshot ?? buildCanvasSnapshot({
      nodes: canvas.nodes,
      connectors: canvas.connectors,
      shapes: canvas.shapes,
    }),
    previewQa: existing?.previewQa,
    notes: existing?.notes,
  });
}

export function withHandoffContext(
  context: ConversationEnvelopeContext | undefined,
): ConversationEnvelopeContext | undefined {
  const sessionId = useSessionStore.getState().currentSessionId;
  if (!isDesignCanvasActiveForSession(sessionId)) return context;
  const designCodeHandoff = buildDesignCodeHandoffContextFromCanvas(context);
  if (!designCodeHandoff) return context;
  return {
    ...(context || {}),
    designCodeHandoff,
  };
}

type AppStoreState = ReturnType<typeof useAppStore.getState>;
type SessionStoreState = ReturnType<typeof useSessionStore.getState>;

type DirectRoutingTarget = Pick<SwarmAgentState, 'id' | 'name'>;

type DirectRoutingResolution =
  | { kind: 'skip' }
  | {
      kind: 'error';
      reason: 'missing-target' | 'attachments-not-supported' | 'targets-unavailable';
      targetIds: string[];
    }
  | {
      kind: 'send';
      targets: DirectRoutingTarget[];
      targetIds: string[];
      missingTargetIds: string[];
    };

export function isRuntimeBusyStatus(status: TaskSessionStatus | undefined): boolean {
  return status === 'running'
    || status === 'paused'
    || status === 'queued';
}

function isRuntimeCancellingStatus(status: TaskSessionStatus | undefined): boolean {
  return status === 'cancelling';
}

function markLatestUserMessageRunCancelled(cancelledAt: number): void {
  const sessionStore = useSessionStore.getState();
  const latestUser = [...sessionStore.messages]
    .reverse()
    .find((message) => message.role === 'user' && !message.isMeta);
  if (!latestUser) return;

  sessionStore.updateMessage(latestUser.id, {
    metadata: {
      ...latestUser.metadata,
      workbench: {
        ...latestUser.metadata?.workbench,
        runCancellation: {
          status: 'cancelled',
          cancelledAt,
          reason: 'user_cancelled',
        },
      },
    },
  });
}

export function getRuntimeFollowupFailureMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error || 'Unknown error');
  if (/already cancelling/i.test(raw)) {
    return '上一轮还在暂停或收尾，等它回到运行中再发。草稿还在输入框里。';
  }
  if (/agent not initialized|no active session|not initialized/i.test(raw)) {
    return '当前任务还没准备好接收引导消息，稍后再发一次。';
  }
  return `引导消息没发出去：${raw}`;
}

export function getAgentSendFailureMessage(error: unknown): string {
  const raw = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : '';
  const message = raw.trim();
  return message
    ? `Error: ${message}`
    : 'Error: 消息发送失败，但前端没有收到具体错误。请查看后台日志。';
}

export function getRuntimeInputMode(context?: ConversationEnvelopeContext): RuntimeInputMode {
  return context?.runtimeInput?.mode === 'redirect' ? 'redirect' : 'supplement';
}

/**
 * 「这个 session 还有一轮没收干净」——host 的 RunSessionConflictError 经 HTTP 出来是 409。
 *
 * 它不是失败：模型上一轮已经答完了（用户也看到了），只是 agent_complete 到流关闭之间
 * 还有几秒收尾，run 仍占着 session。撞上这几秒的消息应该排队等下一轮，而不是给用户
 * 弹一条「云端代理请求失败」——真机 2026-08-01：回复答完 3 秒后发下一条就撞上。
 */
export function isSessionBusyRunConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if ((error as { status?: unknown }).status === 409) return true;
  const message = error instanceof Error ? error.message : '';
  return message.includes('already has active run');
}

export function getRuntimeInputSuccessMessage(mode: RuntimeInputMode): string {
  return mode === 'redirect' ? '已改道处理' : '已加入当前任务';
}

/**
 * Resolve the session a send should bind to.
 * Awaits in-flight createSession so messages land on the new session the user just requested,
 * not the pre-create currentSessionId (cancel-chain B4 race).
 */
export async function resolveEffectiveSessionIdForSend(input: {
  envelopeSessionId?: string | null;
  getCurrentSessionId: () => string | null;
  getPendingSessionCreate: () => Promise<{ id: string } | null> | null;
  createFallbackSession: () => Promise<{ id: string } | null>;
  now?: () => number;
}): Promise<string> {
  const pendingCreate = input.getPendingSessionCreate();
  if (pendingCreate) {
    const created = await pendingCreate;
    if (input.envelopeSessionId) {
      return input.envelopeSessionId;
    }
    if (created) {
      return created.id;
    }
  }

  // A failed in-flight create leaves currentSessionId pointing at the session
  // visible before the user clicked New. Never silently send there: create a
  // fallback target instead. With no pending create, the current session is valid.
  let effectiveSessionId = input.envelopeSessionId
    ?? (pendingCreate ? null : input.getCurrentSessionId());
  if (!effectiveSessionId) {
    const created = await input.createFallbackSession();
    if (created) {
      effectiveSessionId = created.id;
    } else {
      const tempId = `web-session-${(input.now ?? Date.now)()}`;
      effectiveSessionId = tempId;
    }
  }
  return effectiveSessionId;
}

interface CancelSettlementResponse {
  message?: string;
  runId?: string;
  sessionId?: string;
}

/**
 * Keep re-delivering a 202 cancel request until either the route confirms the
 * same run settled or the terminal SSE event has already converged renderer state.
 */
export async function requestCancelUntilSettled(input: {
  sessionId: string;
  requestCancel: (selector: { runId?: string; sessionId?: string }) => Promise<CancelSettlementResponse | undefined>;
  isCancellationActive: () => boolean;
  wait: () => Promise<void>;
}): Promise<boolean> {
  let selector: { runId?: string; sessionId?: string } = { sessionId: input.sessionId };

  while (true) {
    const result = await input.requestCancel(selector);
    if (result?.message !== 'cancel_requested') {
      return true;
    }

    // Retrying by session could cancel a follow-up run that starts after the
    // original one settles. A3 responses include runId so retries stay fenced.
    if (!result.runId) {
      return false;
    }
    selector = {
      runId: result.runId,
      sessionId: result.sessionId ?? input.sessionId,
    };

    await input.wait();
    if (!input.isCancellationActive()) {
      return false;
    }
  }
}

export interface SendMessageOptions {
  silentFailure?: boolean;
}

export function resolveDirectRouting(
  envelope: ConversationEnvelope,
  agents: DirectRoutingTarget[],
): DirectRoutingResolution {
  const routing = envelope.context?.routing;
  if (routing?.mode !== 'direct') {
    return { kind: 'skip' };
  }

  if ((envelope.attachments?.length || 0) > 0) {
    return {
      kind: 'error',
      reason: 'attachments-not-supported',
      targetIds: routing.targetAgentIds || [],
    };
  }

  const targetIds = Array.from(new Set(routing.targetAgentIds || []));
  if (targetIds.length === 0) {
    return {
      kind: 'error',
      reason: 'missing-target',
      targetIds,
    };
  }

  const agentMap = new Map(agents.map((agent) => [agent.id, agent]));
  const targets = targetIds
    .map((id) => agentMap.get(id))
    .filter((agent): agent is DirectRoutingTarget => Boolean(agent));

  if (targets.length === 0) {
    return {
      kind: 'error',
      reason: 'targets-unavailable',
      targetIds,
    };
  }

  return {
    kind: 'send',
    targets,
    targetIds,
    missingTargetIds: targetIds.filter((id) => !agentMap.has(id)),
  };
}

function toWorkbenchMetadata(
  context?: ConversationEnvelopeContext,
  directTargets: DirectRoutingTarget[] = [],
): WorkbenchMessageMetadata | undefined {
  if (!context) return undefined;

  const metadata: WorkbenchMessageMetadata = {};

  if (context.workingDirectory !== undefined) {
    metadata.workingDirectory = context.workingDirectory;
  }
  if (context.preferredAgentId !== undefined) {
    metadata.preferredAgentId = context.preferredAgentId;
  }
  if (context.preferredAgentName !== undefined) {
    metadata.preferredAgentName = context.preferredAgentName;
  }
  if (context.selectedAgent) {
    metadata.selectedAgent = { ...context.selectedAgent };
  }
  if (context.selectedPromptCommand) {
    metadata.selectedPromptCommand = {
      ...context.selectedPromptCommand,
      hints: context.selectedPromptCommand.hints ? [...context.selectedPromptCommand.hints] : undefined,
    };
  }
  if (context.pendingCommand) {
    metadata.pendingCommand = { ...context.pendingCommand };
  }
  if (context.routing) {
    metadata.routingMode = context.routing.mode;
    if (context.routing.targetAgentIds?.length) {
      metadata.targetAgentIds = [...context.routing.targetAgentIds];
      if (directTargets.length > 0) {
        metadata.targetAgentNames = directTargets.map((target) => target.name);
      }
    }
    // targetAgentIds are routing intent. Actual delivery evidence is recorded
    // only after Host replies; preflight candidates must never be persisted as
    // delivered because a target can finish between availability check and send.
  }
  if (context.selectedSkillIds?.length) {
    metadata.selectedSkillIds = [...context.selectedSkillIds];
  }
  if (context.selectedConnectorIds?.length) {
    metadata.selectedConnectorIds = [...context.selectedConnectorIds];
  }
  if (context.selectedMcpServerIds?.length) {
    metadata.selectedMcpServerIds = [...context.selectedMcpServerIds];
  }
  if (context.turnCapabilityScopeMode) {
    metadata.turnCapabilityScopeMode = context.turnCapabilityScopeMode;
  }
  if (context.designBrief) {
    metadata.designBrief = context.designBrief;
  }
  if (context.designAcceptanceContract) {
    metadata.designAcceptanceContract = context.designAcceptanceContract;
  }
  if (context.designCodeHandoff) {
    metadata.designCodeHandoff = context.designCodeHandoff;
  }
  if (context.executionIntent) {
    metadata.executionIntent = {
      ...context.executionIntent,
    };
  }
  if (context.runtimeInput) {
    metadata.runtimeInputMode = context.runtimeInput.mode;
  }
  if (context.voiceInput) {
    metadata.voiceInput = { ...context.voiceInput };
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

export function toMessageMetadata(
  context?: ConversationEnvelopeContext,
  directTargets: DirectRoutingTarget[] = [],
): MessageMetadata | undefined {
  const workbench = toWorkbenchMetadata(context, directTargets);
  return workbench ? { workbench } : undefined;
}

interface UseAgentIPCArgs {
  addMessage: SessionStoreState['addMessage'];
  currentSessionId: string | null;
  currentTurnMessageIdRef: MutableRefObject<string | null>;
  isProcessing: boolean;
  setIsProcessing: AppStoreState['setIsProcessing'];
  setSessionProcessing: AppStoreState['setSessionProcessing'];
}

export function useAgentIPC({
  addMessage,
  currentSessionId,
  currentTurnMessageIdRef,
  isProcessing,
  setIsProcessing,
  setSessionProcessing,
}: UseAgentIPCArgs) {
  // Send a message to the agent
  // Turn-based model: 不再预创建 placeholder，等待后端 turn_start 事件
  // 运行中继续发送时，直接交给前台 brain；短暂拒收由 host 输入投递层缓冲重投。
  const sendMessage = useCallback(
    async (envelope: ConversationEnvelope, options?: SendMessageOptions) => {
      const { content, attachments, context } = envelope;
      logger.debug('sendMessage called', { contentPreview: content.substring(0, 50), sessionId: currentSessionId });

      // 空消息检查
      if (!content.trim() && !attachments?.length) {
        logger.debug('sendMessage blocked - empty content');
        return;
      }

      // 建会话竞态：点「新会话」后 create 尚未完成时，composer 仍挂在旧 currentSessionId。
      // await 进行中的 create 并把消息绑到新会话；运行会话 = composer 会话重新成立。
      if (useSessionStore.getState().getPendingSessionCreate()) {
        logger.info('sendMessage - awaiting in-flight session create before bind');
      }
      const effectiveSessionId = await resolveEffectiveSessionIdForSend({
        envelopeSessionId: envelope.sessionId,
        getCurrentSessionId: () => useSessionStore.getState().currentSessionId,
        getPendingSessionCreate: () => useSessionStore.getState().getPendingSessionCreate(),
        createFallbackSession: async () => {
          logger.warn('sendMessage - no current session, creating fallback');
          const created = await useSessionStore.getState().createSession('新对话');
          if (!created) {
            const tempId = `web-session-${Date.now()}`;
            logger.warn('sendMessage - session creation failed, using temp sessionId', { tempId });
            useSessionStore.setState({ currentSessionId: tempId });
            return { id: tempId };
          }
          return created;
        },
      });

      const swarmState = useSwarmStore.getState();
      const sessionSnapshot = swarmState.activeSessionId === effectiveSessionId && swarmState.activeRunId
        ? {
            runId: swarmState.activeRunId,
            agents: swarmState.agents,
          }
        : Object.values(swarmState.runSnapshots)
            .filter((snapshot) => snapshot.sessionId === effectiveSessionId)
            .sort((left, right) => {
              if (left.isRunning !== right.isRunning) return left.isRunning ? -1 : 1;
              return (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
            })[0];
      const swarmAgents = sessionSnapshot?.agents ?? [];
      const directRouting = resolveDirectRouting(envelope, swarmAgents);

      // 读取当前 session 锁定的 design brief（来自 question-form 提交，仅运行时内存态）。
      // 三条 IPC 路径（direct routing / runtime follow-up / auto）都会在 content 前面 prepend
      // 一段 <system-reminder> 让下一轮 LLM 按 brief 出 artifact，不进 store/DB。
      const sessionDesignBrief = enrichDesignBrief(effectiveSessionId
        ? useSessionStore.getState().getSessionDesignBrief(effectiveSessionId)
        : undefined);
      const contextWithDesignContext = withDesignCanvasActiveIntent(
        withHandoffContext(
          withCanvasSnapshotContext(
            withDesignBriefContext(context, sessionDesignBrief),
          ),
        ),
        effectiveSessionId,
      );

      if (directRouting.kind === 'error') {
        const errorContent =
          directRouting.reason === 'attachments-not-supported'
            ? 'Direct 路由暂不支持附件，先去掉附件，或切回 Auto / Parallel。'
            : directRouting.reason === 'missing-target'
              ? 'Direct 模式还没选中 agent，先在输入框上方选一个目标 agent。'
              : 'Direct 模式选中的 agent 当前不可用，先检查 swarm 是否仍在运行。';

        addMessage({
          id: generateMessageId(),
          role: 'assistant',
          content: errorContent,
          timestamp: Date.now(),
        });
        return;
      }

      if (directRouting.kind === 'send') {
        const directRunId = sessionSnapshot!.runId;
        const isDirectScopeActive = () => {
          const sessionState = useSessionStore.getState();
          const currentSwarm = useSwarmStore.getState();
          return sessionState.currentSessionId === effectiveSessionId
            && currentSwarm.activeSessionId === effectiveSessionId
            && currentSwarm.activeRunId === directRunId;
        };
        const addDirectMessage = (message: Message) => {
          if (isDirectScopeActive()) useSessionStore.getState().addMessage(message);
        };
        const userMessage: Message = {
          id: generateMessageId(),
          role: 'user',
          content,
          timestamp: Date.now(),
          metadata: toMessageMetadata(contextWithDesignContext, directRouting.targets),
        };
        addDirectMessage(userMessage);

        const rollbackDirectMessage = () => {
          if (!isDirectScopeActive()) return;
          const sessionState = useSessionStore.getState();
          sessionState.setMessages(sessionState.messages.filter((message) => message.id !== userMessage.id));
        };

        try {
          const directMessage = applyDesignCanvasSessionToContent(
            applyDesignCodeHandoffToContent(
              applyDesignAcceptanceContractToContent(
                applyDesignBriefToContent(content.trim(), sessionDesignBrief),
                contextWithDesignContext?.designAcceptanceContract,
              ),
              contextWithDesignContext?.designCodeHandoff,
            ),
            effectiveSessionId,
          );
          const results = await Promise.allSettled(
            directRouting.targets.map((target) =>
              Promise.resolve().then(() => ipcService.invoke(IPC_CHANNELS.SWARM_SEND_USER_MESSAGE, {
                agentId: target.id,
                message: directMessage,
                sessionId: effectiveSessionId!,
                runId: directRunId,
                messageId: userMessage.id,
                timestamp: userMessage.timestamp,
                metadata: userMessage.metadata,
              })),
            ),
          );

          const deliveredTargets = directRouting.targets.filter((_, index) => {
            const result = results[index];
            return result?.status === 'fulfilled' && Boolean(result.value?.delivered);
          });
          // Multi-target Direct uses one canonical session message. A single
          // successful persistence makes that shared turn durable for every
          // delivered target; duplicate inserts on later targets are idempotent.
          const canonicalPersisted = results.some((result) => (
            result.status === 'fulfilled' && Boolean(result.value?.persisted)
          ));
          const unpersistedTargetIds = canonicalPersisted
            ? []
            : deliveredTargets.map((target) => target.id);
          const failedTargetIds = directRouting.targets
            .filter((_, index) => {
              const result = results[index];
              return result?.status === 'rejected' || !result?.value?.delivered;
            })
            .map((target) => target.id);

          if (deliveredTargets.length === 0) {
            rollbackDirectMessage();
            addDirectMessage({
              id: generateMessageId(),
              role: 'assistant',
              content: 'Direct 路由发送失败，消息未送达，也没有写入当前 Team 记录。请重试，或切回 Auto / Parallel。',
              timestamp: Date.now(),
            });
            return;
          }

          if (effectiveSessionId) {
            useTurnExecutionStore.getState().recordRoutingEvidence(effectiveSessionId, {
              kind: 'direct',
              mode: 'direct',
              timestamp: userMessage.timestamp,
              turnMessageId: userMessage.id,
              targetAgentIds: directRouting.targetIds,
              targetAgentNames: directRouting.targets.map((target) => target.name),
              deliveredTargetIds: deliveredTargets.map((target) => target.id),
              missingTargetIds: [...directRouting.missingTargetIds, ...failedTargetIds],
            });
          }

          if (isDirectScopeActive()) {
            useAppStore.getState().setSelectedSwarmAgentId(deliveredTargets[0]?.id || null);
          }

          const undeliveredTargetIds = [...directRouting.missingTargetIds, ...failedTargetIds];
          if (undeliveredTargetIds.length > 0 || unpersistedTargetIds.length > 0) {
            const details = [
              undeliveredTargetIds.length > 0 ? `未送达 ${undeliveredTargetIds.join('、')}` : '',
              unpersistedTargetIds.length > 0
                ? `已送达但未写入 Team 记录 ${unpersistedTargetIds.join('、')}`
                : '',
            ].filter(Boolean).join('；');
            addDirectMessage({
              id: generateMessageId(),
              role: 'assistant',
              content: `已发送给 ${deliveredTargets.map((target) => target.name).join('、')}。${details}。`,
              timestamp: Date.now(),
            });
          }
        } catch (error) {
          rollbackDirectMessage();
          addDirectMessage({
            id: generateMessageId(),
            role: 'assistant',
            content: 'Direct 路由发送失败，消息未送达，也没有写入当前 Team 记录。请重试，或切回 Auto / Parallel。',
            timestamp: Date.now(),
          });
          logger.error('direct routing send failed', error);
        }
        return;
      }

      // 检查当前会话是否正在处理（允许其他会话并发发送）
      const isCurrentSessionProcessing = effectiveSessionId
        ? (
            useAppStore.getState().isSessionProcessing(effectiveSessionId)
            || isRuntimeBusyStatus(useTaskStore.getState().sessionStates[effectiveSessionId]?.status)
          )
        : isProcessing;
      const currentTaskStatus = effectiveSessionId
        ? useTaskStore.getState().sessionStates[effectiveSessionId]?.status
        : undefined;

      if (isRuntimeCancellingStatus(currentTaskStatus)) {
        throw new Error('Session is already cancelling');
      }

      const deliverToForegroundBrain = async (clientMessageId?: string): Promise<void> => {
        const runtimeInputMode = getRuntimeInputMode(contextWithDesignContext);
        const messageId = clientMessageId ?? generateMessageId();
        const runtimeContext: ConversationEnvelopeContext | undefined = contextWithDesignContext
          ? {
              ...contextWithDesignContext,
              runtimeInput: { mode: runtimeInputMode },
            }
          : { runtimeInput: { mode: runtimeInputMode } };
        const runtimeEnvelope: ConversationEnvelope = {
          ...envelope,
          content: envelope.content,
          attachments,
          context: runtimeContext,
          clientMessageId: messageId,
          sessionId: effectiveSessionId!,
        };
        try {
          const outcome = await ipcService.invokeDomain<SteerOrQueueOutcome>(
            IPC_DOMAINS.AGENT,
            'interrupt',
            runtimeEnvelope,
          );
          if (!useSessionStore.getState().messages.some((message) => message.id === messageId)) {
            addMessage({
              id: messageId,
              role: 'user',
              content: runtimeEnvelope.content,
              attachments: runtimeEnvelope.attachments,
              timestamp: Date.now(),
              metadata: toMessageMetadata(runtimeContext),
            });
          }
          logger.info('sendMessage - foreground input delivery accepted', { outcome: outcome.outcome });
        } catch (error) {
          logger.error('Foreground input delivery failed', error);
          addMessage({
            id: generateMessageId(),
            role: 'assistant',
            content: getAgentSendFailureMessage(error),
            timestamp: Date.now(),
          });
        }
      };

      if (isCurrentSessionProcessing) {
        const voiceCall = useVoiceCallStore.getState();
        // 收成一个「可注入的会话 id」而不是布尔量：后面 payload 直接用它，
        // 类型自然收窄，不必在调用点写非空断言。
        const voiceInjectSessionId = !attachments?.length
          && voiceCall.phase === 'live'
          && effectiveSessionId
          && voiceCall.sessionId === effectiveSessionId
          ? effectiveSessionId
          : undefined;
        const voiceFallbackMessageId = voiceInjectSessionId !== undefined
          ? (envelope.clientMessageId ?? generateMessageId())
          : undefined;

        if (voiceInjectSessionId !== undefined) {
          try {
            const injection = await typedInvokeDomain(VoiceSchemas.INJECT_USER_TEXT, {
              action: 'injectUserText',
              payload: {
                neoSessionId: voiceInjectSessionId,
                text: content,
              },
            });
            if (injection.success && injection.data.outcome === 'injected') {
              logger.info('sendMessage - routed busy text into live voice call');
              return;
            }
            logger.info('sendMessage - voice text injection fell back to foreground input delivery', {
              reason: injection.success
                ? injection.data.outcome === 'fallback' ? injection.data.reason : injection.data.outcome
                : injection.error.code,
            });
          } catch (error) {
            // The typed path must have a durable escape hatch even if the voice
            // bridge itself is unavailable during teardown.
            logger.warn('sendMessage - voice text injection failed; using foreground input delivery', {
              message: error instanceof Error ? error.message : String(error),
            });
          }
        } else {
          logger.info('sendMessage - session processing, delivering runtime input to foreground brain', {
            isCurrentSessionProcessing,
          });
        }
        await deliverToForegroundBrain(voiceFallbackMessageId);
        return;
      }

      // Add user message with UUID
      const userMessage: Message = {
        id: envelope.clientMessageId ?? generateMessageId(),
        role: 'user',
        content,
        timestamp: Date.now(),
        attachments,
        metadata: toMessageMetadata(contextWithDesignContext),
      };
      logger.debug('Adding user message', { id: userMessage.id, attachmentsCount: attachments?.length || 0 });
      // 乐观上屏去重：协作空间 composer 在切会话前已把同 id 消息放上时间线（落地即
      // 进行中态），这里再 append 就是双份——时间线上已有同 id 就跳过（neo 流程同款判法）。
      if (!useSessionStore.getState().messages.some((message) => message.id === userMessage.id)) {
        addMessage(userMessage);
      }

      // 不再预创建 assistant placeholder
      // 后端会在每轮迭代开始时发送 turn_start 事件，前端据此创建消息
      // 这样可以确保：
      // 1. 每轮 Agent Loop 对应一条消息
      // 2. 工具调用后的新响应会创建新消息，而不是追加到旧消息

      // 按会话设置处理状态（允许多会话并发）
      const previousTaskState = effectiveSessionId
        ? useTaskStore.getState().sessionStates[effectiveSessionId]
        : undefined;
      setSessionProcessing(effectiveSessionId!, true);
      useTaskStore.getState().updateSessionState(effectiveSessionId!, {
        status: 'running',
        startTime: Date.now(),
      });
      currentTurnMessageIdRef.current = null; // 重置 turn tracking

      try {
        // Send to main process
        // Note: Don't set isProcessing to false here, it will be set by agent_complete event
        logger.debug('Calling invoke agent:send-message');
        const messagePayload: ConversationEnvelope = {
          ...envelope,
          // 设计画布冷启动引导已改为服务端按轮注入 systemPrompt/turnSystemContext
          // （context.executionIntent.designCanvasActive，见 canvasSessionReminder.ts），
          // 不再 prepend 进 content——content 会被原样持久化+渲染为用户气泡，此前的
          // renderer 侧 prepend 会把 <system-reminder> 全文泄漏进用户可见消息。
          clientMessageId: userMessage.id,
          context: contextWithDesignContext,
          sessionId: effectiveSessionId,
        };
        logger.debug('messagePayload', { type: typeof messagePayload, isObject: typeof messagePayload === 'object' });
        if (typeof messagePayload === 'object') {
          logger.debug('Attachments being sent', { attachments: attachments?.map(a => ({ name: a.name, category: a.category, hasData: !!a.data, dataLen: a.data?.length, path: a.path, hasPath: !!a.path })) });
        }
        await ipcService.invoke('agent:send-message', messagePayload);
        logger.debug('invoke returned');
      } catch (error) {
        logger.error('Agent error', error);
        // 撞上上一轮的收尾窗口（agent_complete 已发、流还没关，run 仍占着 session）：
        // 这不是失败，排到下一轮。复用 userMessage.id 当 clientMessageId，上屏去重
        // 会认出它是同一条，不会重复显示。
        if (isSessionBusyRunConflict(error)) {
          if (effectiveSessionId) {
            setSessionProcessing(effectiveSessionId, false);
            useTaskStore.getState().updateSessionState(
              effectiveSessionId,
              previousTaskState ?? { status: 'idle' },
            );
          }
          await deliverToForegroundBrain(userMessage.id);
          return;
        }
        if (options?.silentFailure === true) {
          if (effectiveSessionId) {
            setSessionProcessing(effectiveSessionId, false);
            // 恢复发送前的终态，避免本次乐观 running 状态阻塞队列层的下一次重试。
            useTaskStore.getState().updateSessionState(
              effectiveSessionId,
              previousTaskState ?? { status: 'idle' },
            );
          }
          throw error;
        }
        // 错误时创建一条错误消息
        const errorMessage: Message = {
          id: generateMessageId(),
          role: 'assistant',
          content: getAgentSendFailureMessage(error),
          timestamp: Date.now(),
        };
        addMessage(errorMessage);
        // 按会话清除处理状态
        setSessionProcessing(effectiveSessionId!, false);
        // taskStore 也必须重置，否则会话永远卡在 'running'：
        // 后续消息全部进入"运行中排队"分支但没有 run 去消费，表现为永远不回复
        useTaskStore.getState().updateSessionState(effectiveSessionId!, {
          status: 'error',
          error: String(error),
        });
      }
    },
    [addMessage, setSessionProcessing, isProcessing, currentSessionId]
  );

  // Cancel the current operation
  const cancel = useCallback(async () => {
    const targetSessionId = currentSessionId;
    try {
      if (targetSessionId) {
        const currentState = useTaskStore.getState().sessionStates[targetSessionId];
        useTaskStore.getState().updateSessionState(targetSessionId, {
          ...currentState,
          status: 'cancelling',
        });
        markLatestUserMessageRunCancelled(Date.now());
      }
      const confirmed = targetSessionId
        ? await requestCancelUntilSettled({
            sessionId: targetSessionId,
            requestCancel: async (selector) => ipcService.invoke('agent:cancel', selector) as Promise<CancelSettlementResponse | undefined>,
            isCancellationActive: () => (
              useTaskStore.getState().sessionStates[targetSessionId]?.status === 'cancelling'
            ),
            wait: () => new Promise((resolve) => setTimeout(resolve, 250)),
          })
        : (await ipcService.invoke('agent:cancel', undefined), true);
      // Honest settle: only mark cancelled when the route confirmed terminal.
      // If SSE settled first, its event handler already owns the final state.
      if (targetSessionId) {
        if (confirmed) {
          useTaskStore.getState().updateSessionState(targetSessionId, { status: 'cancelled' });
          setSessionProcessing(targetSessionId, false);
        }
      } else if (confirmed) {
        setIsProcessing(false);
      }
    } catch (error) {
      logger.error('Cancel error', error);
      if (targetSessionId) {
        useTaskStore.getState().updateSessionState(targetSessionId, { status: 'idle' });
      }
    }
  }, [setIsProcessing, setSessionProcessing, currentSessionId]);

  return {
    sendMessage,
    cancel,
  };
}
