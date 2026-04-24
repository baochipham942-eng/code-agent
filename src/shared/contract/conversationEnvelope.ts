import type { MessageAttachment } from './message';
import type { AppServiceRunOptions } from './appService';
import type { SelectedElementInfo } from '../livePreview/protocol';

export type ConversationRoutingMode = 'auto' | 'direct' | 'parallel';
export type BrowserSessionMode = 'none' | 'managed' | 'desktop';

export interface BrowserSessionIntentPreview {
  url?: string | null;
  title?: string | null;
  frontmostApp?: string | null;
  lastScreenshotAtMs?: number | null;
  surfaceMode?: string | null;
  traceId?: string | null;
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

export interface DirectRoutingDeliverySnapshot {
  deliveredTargetIds: string[];
  deliveredTargetNames?: string[];
  missingTargetIds?: string[];
}

export interface ConversationEnvelopeContext {
  workingDirectory?: string | null;
  routing?: ConversationRouting;
  selectedSkillIds?: string[];
  selectedConnectorIds?: string[];
  selectedMcpServerIds?: string[];
  executionIntent?: ConversationExecutionIntent;
  // Live Preview 选中的 DOM 元素（iframe 点击写入 appStore 的活动 tab），
  // 用于下游 visual_edit 等工具的 grounding。main 侧消费链路分步接入；
  // 本字段非空仅表示 composer 侧已把当前 selection 随 envelope 带出。
  livePreviewSelection?: SelectedElementInfo | null;
}

export interface ConversationEnvelope {
  content: string;
  sessionId?: string;
  attachments?: MessageAttachment[];
  options?: AppServiceRunOptions;
  context?: ConversationEnvelopeContext;
}

export interface WorkbenchMessageMetadata {
  workingDirectory?: string | null;
  routingMode?: ConversationRoutingMode;
  targetAgentIds?: string[];
  targetAgentNames?: string[];
  selectedSkillIds?: string[];
  selectedConnectorIds?: string[];
  selectedMcpServerIds?: string[];
  executionIntent?: ConversationExecutionIntent;
  directRoutingDelivery?: DirectRoutingDeliverySnapshot;
}
