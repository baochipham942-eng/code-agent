// Stream event payload type/interface definitions extracted from useConversationStreamEffects.
import type {
  Message,
  ModelDecisionEventData,
  ModelFallbackStrategy,
  ModelFallbackToolPolicy,
  ModelFallbackTraceStep,
  ModelProviderIdentity,
  ToolCall,
} from '@shared/contract';
import type { AgentEffectsProps } from '../useAgentEffects';

export type AgentEvent = { type: string; data?: unknown; sessionId?: string };

export interface TurnIdPayload {
  turnId?: string;
  isMeta?: boolean;
}

export interface StreamTextPayload extends TurnIdPayload {
  content: string;
}

export interface MessageDeltaPayload extends TurnIdPayload {
  role: 'assistant';
  path: 'content' | 'reasoning';
  op: 'append' | 'replace';
  text: string;
  messageId?: string;
}

export interface MessageSnapshotPayload extends TurnIdPayload {
  role: 'assistant';
  messageId?: string;
  content: string;
  reasoning?: string;
}

export interface AssistantMessagePayload extends TurnIdPayload {
  id?: string;
  content?: string;
  reasoning?: string;
  thinking?: string;
  toolCalls?: ToolCall[];
  contentParts?: Message['contentParts'];
  artifacts?: Message['artifacts'];
  modelDecision?: ModelDecisionEventData;
}

export interface RoutingResolvedPayload {
  mode: 'auto' | 'explicit';
  timestamp?: number;
  agentId: string;
  agentName: string;
  reason: string;
  score: number;
  fallbackToDefault?: boolean;
  /** 用户显式请求的 agent id；与 agentId 不一致 = 显式选择已降级 */
  requestedAgentId?: string;
}

export interface ModelFallbackPayload {
  reason: string;
  from: string;
  to: string;
  category?: string;
  strategy?: ModelFallbackStrategy;
  tried?: ModelFallbackTraceStep[];
  skipped?: ModelFallbackTraceStep[];
  toolPolicy?: ModelFallbackToolPolicy;
  fromIdentity?: ModelProviderIdentity;
  toIdentity?: ModelProviderIdentity;
}

export type NormalizedToolTokenSavingsMeasurementSource = 'tool-spec-local-estimate' | 'provider-reported' | 'not-measured';
export type NormalizedToolTokenSavingsUsageSource = 'model-response-usage' | 'unavailable';

export interface ConversationStreamEventActions {
  addMessage: (message: Message) => void;
  appendStreamingMessageDelta?: (messageId: string, delta: { content?: string; reasoning?: string }) => void;
  updateMessage: (id: string, updates: Partial<Message>) => void;
  setMessages: (messages: Message[]) => void;
  getMessages: () => Message[];
  queueUpdate: (update: Parameters<AgentEffectsProps['queueUpdate']>[0]) => void;
  now?: () => number;
  generateId?: () => string;
}
