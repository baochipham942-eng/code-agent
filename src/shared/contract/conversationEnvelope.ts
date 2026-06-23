import type { MessageAttachment } from './message';
import type { AppServiceRunOptions } from './appService';
import type { SelectedElementInfo } from '../livePreview/protocol';
import type { ManagedBrowserProfileMode } from './desktop';
import type { DesignBrief } from './designBrief';
import type { CanvasSnapshot } from './canvasProposal';

export type ConversationRoutingMode = 'auto' | 'direct' | 'parallel';
export type BrowserSessionMode = 'none' | 'managed' | 'desktop';
export type RuntimeInputMode = 'supplement' | 'redirect';
export type RuntimeInputDelivery = 'in_flight' | 'queued_next_turn';
export type TurnCapabilityScopeMode = 'auto' | 'manual';

export interface BrowserSessionIntentPreview {
  url?: string | null;
  title?: string | null;
  frontmostApp?: string | null;
  lastScreenshotAtMs?: number | null;
  surfaceMode?: string | null;
  traceId?: string | null;
  sessionId?: string | null;
  profileId?: string | null;
  profileMode?: ManagedBrowserProfileMode | null;
  artifactDirSummary?: string | null;
  workspaceScopeSummary?: string | null;
}

export interface BrowserSessionIntentSnapshot {
  ready: boolean;
  blockedDetail?: string;
  blockedHint?: string;
  preview?: BrowserSessionIntentPreview;
}

export interface WorkbenchToolScope {
  allowedSkillIds?: string[];
  allowedConnectorIds?: string[];
  allowedMcpServerIds?: string[];
}

export interface ConversationRouting {
  mode: ConversationRoutingMode;
  targetAgentIds?: string[];
}

export interface ConversationExecutionIntent {
  allowParallelPlanPreview?: boolean;
  browserSessionMode?: Exclude<BrowserSessionMode, 'none'>;
  preferBrowserSession?: boolean;
  preferDesktopContext?: boolean;
  allowBrowserAutomation?: boolean;
  browserSessionSnapshot?: BrowserSessionIntentSnapshot;
}

export interface ComposerPromptCommandSelection {
  name: string;
  source?: 'file' | 'mcp' | 'builtin';
  hints?: string[];
  via?: 'slash_picker' | 'typed_slash';
}

export interface ComposerAgentSelection {
  id: string | null;
  name?: string;
  token?: string;
  via?: 'slash_picker' | 'agent_command' | 'agent_chip';
}

export interface RuntimeInputIntent {
  mode: RuntimeInputMode;
  delivery?: RuntimeInputDelivery;
}

export interface ConversationVoiceInputMetadata {
  inputSource: 'voice';
  asrEngine?: string;
  language?: string;
  model?: string;
  durationMs?: number;
  audioDurationSeconds?: number;
  transcriptionMode?: string;
  transcriptChars?: number;
  rawTranscriptChars?: number;
  postProcessed?: boolean;
  chunkCount?: number;
}

export interface DirectRoutingDeliverySnapshot {
  deliveredTargetIds: string[];
  deliveredTargetNames?: string[];
  missingTargetIds?: string[];
}

export interface ConversationEnvelopeContext {
  workingDirectory?: string | null;
  preferredAgentId?: string | null;
  preferredAgentName?: string | null;
  selectedAgent?: ComposerAgentSelection;
  selectedPromptCommand?: ComposerPromptCommandSelection;
  routing?: ConversationRouting;
  selectedSkillIds?: string[];
  selectedConnectorIds?: string[];
  selectedMcpServerIds?: string[];
  turnCapabilityScopeMode?: TurnCapabilityScopeMode;
  designBrief?: DesignBrief;
  /** 设计画布当前快照（ADR-026 D1-B）：design 模式发轮时 renderer 附带，注入 agent 上下文供 ProposeCanvasOps 引用真实节点 id。运行时态，不进 DB。 */
  canvasSnapshot?: CanvasSnapshot;
  executionIntent?: ConversationExecutionIntent;
  runtimeInput?: RuntimeInputIntent;
  voiceInput?: ConversationVoiceInputMetadata;
  // Live Preview 选中的 DOM 元素（iframe 点击写入 appStore 的活动 tab），
  // 用于下游 visual_edit 等工具的 grounding。main 侧消费链路分步接入；
  // 本字段非空仅表示 composer 侧已把当前 selection 随 envelope 带出。
  livePreviewSelection?: SelectedElementInfo | null;
}

export interface ConversationEnvelope {
  content: string;
  clientMessageId?: string;
  sessionId?: string;
  attachments?: MessageAttachment[];
  options?: AppServiceRunOptions;
  context?: ConversationEnvelopeContext;
}

export interface WorkbenchMessageMetadata {
  workingDirectory?: string | null;
  preferredAgentId?: string | null;
  preferredAgentName?: string | null;
  selectedAgent?: ComposerAgentSelection;
  selectedPromptCommand?: ComposerPromptCommandSelection;
  routingMode?: ConversationRoutingMode;
  targetAgentIds?: string[];
  targetAgentNames?: string[];
  selectedSkillIds?: string[];
  selectedConnectorIds?: string[];
  selectedMcpServerIds?: string[];
  turnCapabilityScopeMode?: TurnCapabilityScopeMode;
  designBrief?: DesignBrief;
  executionIntent?: ConversationExecutionIntent;
  runtimeInputMode?: RuntimeInputMode;
  runtimeInputDelivery?: RuntimeInputDelivery;
  voiceInput?: ConversationVoiceInputMetadata;
  directRoutingDelivery?: DirectRoutingDeliverySnapshot;
  runCancellation?: {
    status: 'cancelled';
    cancelledAt: number;
    reason?: string;
  };
}
