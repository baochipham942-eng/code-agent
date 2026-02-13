// ============================================================================
// JSON Output - JSON 格式输出
// ============================================================================

import type { AgentEvent, ToolCall, ToolResult } from '../../shared/types';
import type { SwarmEvent } from '../../shared/types/swarm';
import type { CLIOutputEvent, CLIRunResult } from '../types';

/**
 * JSON 输出管理器
 */
export class JSONOutput {
  private events: CLIOutputEvent[] = [];
  private startTime: number = 0;
  private toolsUsed: string[] = [];

  /**
   * 开始新的运行
   */
  start(): void {
    this.events = [];
    this.startTime = Date.now();
    this.toolsUsed = [];
  }

  /**
   * 输出单个事件（NDJSON 格式）
   */
  emitEvent(event: CLIOutputEvent): void {
    console.log(JSON.stringify(event));
  }

  /**
   * 处理 Agent 事件
   */
  handleEvent(event: AgentEvent): void {
    const timestamp = Date.now();

    switch (event.type) {
      case 'task_progress':
        this.emitEvent({
          type: 'thinking',
          timestamp,
          data: {
            phase: event.data?.phase,
            step: event.data?.step,
          },
        });
        break;

      case 'stream_chunk':
        // 流式内容不输出为 JSON 事件，累积后在 message 中输出
        break;

      case 'tool_call_start':
        if (event.data) {
          const toolCall = event.data as ToolCall;
          this.toolsUsed.push(toolCall.name);
          this.emitEvent({
            type: 'tool_call',
            timestamp,
            data: {
              id: toolCall.id,
              name: toolCall.name,
              arguments: toolCall.arguments,
            },
          });
        }
        break;

      case 'tool_call_end':
        if (event.data) {
          const result = event.data as ToolResult;
          this.emitEvent({
            type: 'tool_result',
            timestamp,
            data: {
              toolCallId: result.toolCallId,
              success: result.success,
              output: result.output,
              error: result.error,
              duration: result.duration,
            },
          });
        }
        break;

      case 'message':
        if (event.data?.role === 'assistant' && event.data?.content) {
          this.emitEvent({
            type: 'message',
            timestamp,
            data: {
              content: event.data.content,
            },
          });
        }
        break;

      case 'error':
        this.emitEvent({
          type: 'error',
          timestamp,
          data: {
            message: event.data?.message,
            code: event.data?.code,
          },
        });
        break;

      case 'agent_complete':
        this.emitEvent({
          type: 'complete',
          timestamp,
          data: {
            duration: Date.now() - this.startTime,
            toolsUsed: [...new Set(this.toolsUsed)],
          },
        });
        break;
    }
  }

  /**
   * 处理 Swarm 事件（NDJSON 格式输出）
   */
  handleSwarmEvent(event: SwarmEvent): void {
    console.log(JSON.stringify({ type: 'swarm_event', event_type: event.type, timestamp: event.timestamp, data: event.data }));
  }

  /**
   * 输出最终结果
   */
  result(result: CLIRunResult): void {
    console.log(JSON.stringify(result, null, 2));
  }

  /**
   * 输出错误
   */
  error(message: string, code?: string): void {
    console.error(JSON.stringify({
      success: false,
      error: message,
      code,
    }));
  }
}

// 导出单例
export const jsonOutput = new JSONOutput();
