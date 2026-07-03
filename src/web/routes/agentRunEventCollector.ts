import type { AgentEvent, Message } from '../../shared/contract';
import type { CachedToolCall } from '../helpers/sessionCache';

export type AgentRunContentPart =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; toolCallId: string };

interface AgentRunEventCollectorDeps {
  sessionId: string;
  emitToolWarning: (data: { message: string; level: 'warning'; sessionId: string }) => void;
}

export class AgentRunEventCollector {
  assistantText = '';
  assistantThinking = '';
  /** message 事件上最后一次出现的 assistant metadata（turnQuality 徽标数据），落库时对称带上 */
  assistantMetadata: Message['metadata'] | undefined;
  readonly assistantToolCalls: CachedToolCall[] = [];
  readonly loopEmittedAssistantMessageIds = new Set<string>();
  readonly contentParts: AgentRunContentPart[] = [];
  runCancelled = false;

  private consecutiveToolFailures = 0;
  private lastPartType: AgentRunContentPart['type'] | null = null;

  constructor(private readonly deps: AgentRunEventCollectorDeps) {}

  observe(event: AgentEvent, emitted: boolean): void {
    if (!emitted) return;

    if (event.type === 'agent_cancelled') {
      this.runCancelled = true;
      return;
    }

    if (event.type === 'message') {
      this.recordLoopMessage(event.data);
      return;
    }

    if (event.type === 'message_delta') {
      if (event.data.text && event.data.path === 'content') {
        this.appendText(event.data.text);
      } else if (event.data.text && event.data.path === 'reasoning') {
        this.assistantThinking += event.data.text;
      }
      return;
    }

    if (event.type === 'stream_chunk') {
      if (event.data.content) this.appendText(event.data.content);
      return;
    }

    if (event.type === 'stream_reasoning') {
      if (event.data.content) this.assistantThinking += event.data.content;
      return;
    }

    if (event.type === 'tool_call_start') {
      this.recordToolCallStart(event.data.id, event.data.name);
      return;
    }

    if (event.type === 'tool_call_end') {
      this.recordToolCallEnd(event.data);
    }
  }

  hasAssistantOutput(): boolean {
    return this.assistantText.length > 0 || this.assistantToolCalls.length > 0;
  }

  hasInterleaving(): boolean {
    return this.contentParts.length > 1
      || (this.contentParts.length === 1 && this.assistantToolCalls.length > 0 && this.assistantText.length > 0);
  }

  private appendText(text: string): void {
    if (this.lastPartType !== 'text') {
      this.contentParts.push({ type: 'text', text: '' });
      this.lastPartType = 'text';
    }
    const lastPart = this.contentParts[this.contentParts.length - 1];
    if (lastPart?.type === 'text') lastPart.text += text;
    this.assistantText += text;
  }

  private recordLoopMessage(message: Message): void {
    if (message.role !== 'assistant') return;
    if (message.id) {
      this.loopEmittedAssistantMessageIds.add(message.id);
    }
    if (message.metadata) {
      this.assistantMetadata = message.metadata;
    }
  }

  private recordToolCallStart(id?: string, name?: string): void {
    const toolCallId = id || `tool-${this.assistantToolCalls.length}`;
    this.assistantToolCalls.push({
      id: toolCallId,
      name: name || 'unknown',
    });
    this.contentParts.push({ type: 'tool_call', toolCallId });
    this.lastPartType = 'tool_call';
  }

  private recordToolCallEnd(data: Extract<AgentEvent, { type: 'tool_call_end' }>['data']): void {
    const callId = data.toolCallId;
    if (callId) {
      const toolCall = this.assistantToolCalls.find((candidate) => candidate.id === callId);
      if (toolCall) {
        toolCall.result = {
          success: !!data.success,
          output: data.success ? String(data.output || '').substring(0, 200) : undefined,
          error: data.success ? undefined : String(data.error || 'unknown'),
          metadata: data.metadata as Record<string, unknown> | undefined,
        };
      }
    }

    if (!data.success) {
      this.consecutiveToolFailures++;
      if (this.consecutiveToolFailures >= 2) {
        this.deps.emitToolWarning({
          message: `工具连续 ${this.consecutiveToolFailures} 次失败: ${data.error || 'unknown'}`,
          level: 'warning',
          sessionId: this.deps.sessionId,
        });
      }
    } else {
      this.consecutiveToolFailures = 0;
    }
  }
}
