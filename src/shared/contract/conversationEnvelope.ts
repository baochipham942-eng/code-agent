import type { MessageAttachment } from './message';
import type { AppServiceRunOptions } from './appService';

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
