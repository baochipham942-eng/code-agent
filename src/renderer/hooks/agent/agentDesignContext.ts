// 设计 brief / 画布快照 / Design->Code handoff 的 envelope context 组装（从 useAgentIPC 抽出，
// 纯函数搬移，无逻辑改动；模型可见的 reminder 字符串逐字节未动）。
import type { ConversationEnvelopeContext } from '@shared/contract/conversationEnvelope';
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
import { formatDesignCanvasSessionReminder } from '@shared/design/canvasSessionReminder';
import { useDesignCanvasStore } from '../../components/design/designCanvasStore';
import { isDesignCanvasActiveForSession } from '../../components/design/designCanvasSessionGate';
import { buildCanvasSnapshot } from '../../components/design/buildCanvasSnapshot';
import { isReferenceNode, isVideoNode, type CanvasNode } from '../../components/design/designCanvasTypes';
import { useSessionStore } from '../../stores/sessionStore';

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

export function applyDesignBriefToContent(content: string, brief: DesignBrief | undefined): string {
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

export function applyDesignAcceptanceContractToContent(
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

export function applyDesignCodeHandoffToContent(
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

export function enrichDesignBrief(brief: DesignBrief | undefined): DesignBrief | undefined {
  if (!brief) return undefined;
  return normalizeDesignBrief({
    ...brief,
    directionTokens: brief.directionTokens || (brief.direction ? directionTokens[brief.direction] : undefined),
  });
}

export function withDesignBriefContext(
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

function buildDesignCodeHandoffContextFromCanvas(
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
