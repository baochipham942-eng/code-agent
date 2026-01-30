import { ExecutionTrace, ToolCall, AgentDispatch } from '../types.js';

/**
 * 从 CLI 输出解析执行轨迹
 * 支持两种格式:
 *
 * 1. code-agent 格式:
 *    - {"type":"tool_call","data":{"id":"...","name":"...","arguments":{...}}}
 *    - {"type":"tool_result","data":{"toolCallId":"...","success":true,"output":"..."}}
 *
 * 2. Claude CLI stream-json 格式:
 *    - {"type":"assistant","message":{"content":[{"type":"tool_use",...}]}}
 *    - {"type":"user","message":{"content":[{"type":"tool_result",...}]}}
 */
export function parseExecutionTrace(streamOutput: string): ExecutionTrace {
  const toolCalls: ToolCall[] = [];
  const agentDispatches: AgentDispatch[] = [];
  const timeline: (ToolCall | AgentDispatch)[] = [];

  const lines = streamOutput.split('\n').filter(Boolean);
  const toolCallMap = new Map<string, ToolCall>();
  const agentDispatchMap = new Map<string, AgentDispatch>();
  const currentAgentStack: AgentDispatch[] = [];

  for (const line of lines) {
    try {
      const event = JSON.parse(line);

      // ===== code-agent 格式 =====
      if (event.type === 'tool_call' && event.data) {
        const toolCall = parseCodeAgentToolCall(event.data);
        toolCallMap.set(event.data.id, toolCall);

        // 检查是否是 spawn_agent 工具 (agent dispatch)
        if (event.data.name === 'spawn_agent') {
          const dispatch = parseCodeAgentDispatch(event.data);
          if (currentAgentStack.length > 0) {
            dispatch.parentAgentId =
              currentAgentStack[currentAgentStack.length - 1].id;
          }
          currentAgentStack.push(dispatch);
          agentDispatches.push(dispatch);
          agentDispatchMap.set(event.data.id, dispatch);
          timeline.push(dispatch);
        } else {
          if (currentAgentStack.length > 0) {
            currentAgentStack[currentAgentStack.length - 1].toolCalls.push(toolCall);
          } else {
            toolCalls.push(toolCall);
          }
          timeline.push(toolCall);
        }
      }

      // code-agent tool_result
      if (event.type === 'tool_result' && event.data) {
        const call = toolCallMap.get(event.data.toolCallId);
        if (call) {
          call.output = event.data.output;
          call.error = event.data.error;
          call.duration = event.data.duration || 0;
        }

        const dispatch = agentDispatchMap.get(event.data.toolCallId);
        if (dispatch) {
          dispatch.result = event.data.output;
          currentAgentStack.pop();
        }
      }

      // ===== Claude CLI stream-json 格式 =====
      if (event.type === 'assistant' && event.message?.content) {
        for (const content of event.message.content) {
          if (content.type === 'tool_use') {
            const toolCall = parseClaudeToolCall(content);
            toolCallMap.set(content.id, toolCall);

            if (content.name === 'Task') {
              const dispatch = parseClaudeAgentDispatch(content);
              if (currentAgentStack.length > 0) {
                dispatch.parentAgentId =
                  currentAgentStack[currentAgentStack.length - 1].id;
              }
              currentAgentStack.push(dispatch);
              agentDispatches.push(dispatch);
              agentDispatchMap.set(content.id, dispatch);
              timeline.push(dispatch);
            } else {
              if (currentAgentStack.length > 0) {
                currentAgentStack[currentAgentStack.length - 1].toolCalls.push(
                  toolCall
                );
              } else {
                toolCalls.push(toolCall);
              }
              timeline.push(toolCall);
            }
          }
        }
      }

      if (event.type === 'user' && event.message?.content) {
        for (const content of event.message.content) {
          if (content.type === 'tool_result') {
            const call = toolCallMap.get(content.tool_use_id);
            if (call) {
              call.output = content.content;
              call.error = content.is_error ? content.content : undefined;
            }

            const dispatch = agentDispatchMap.get(content.tool_use_id);
            if (dispatch) {
              dispatch.result = content.content;
              currentAgentStack.pop();
            }
          }
        }
      }
    } catch {
      // 跳过非 JSON 行
    }
  }

  return {
    toolCalls,
    agentDispatches,
    totalApiCalls: countApiCalls(lines),
    totalToolCalls:
      toolCalls.length +
      agentDispatches.reduce((sum, a) => sum + a.toolCalls.length, 0),
    totalAgentDispatches: agentDispatches.length,
    timeline,
  };
}

// ===== code-agent 格式解析 =====

function parseCodeAgentToolCall(data: any): ToolCall {
  return {
    id: data.id || `tool-${Date.now()}`,
    name: data.name,
    input: data.arguments || {},
    duration: 0,
    timestamp: Date.now(),
  };
}

function parseCodeAgentDispatch(data: any): AgentDispatch {
  const args = data.arguments || {};
  return {
    id: data.id || `agent-${Date.now()}`,
    agentType: args.agent_type || args.role || 'unknown',
    prompt: args.task || args.prompt || '',
    toolCalls: [],
    duration: 0,
    timestamp: Date.now(),
  };
}

// ===== Claude CLI 格式解析 =====

function parseClaudeToolCall(content: any): ToolCall {
  return {
    id: content.id || `tool-${Date.now()}`,
    name: content.name,
    input: content.input || {},
    duration: 0,
    timestamp: Date.now(),
  };
}

function parseClaudeAgentDispatch(content: any): AgentDispatch {
  const input = content.input || {};
  return {
    id: content.id || `agent-${Date.now()}`,
    agentType: input.subagent_type || input.agent_type || 'unknown',
    prompt: input.prompt || input.description || '',
    toolCalls: [],
    duration: 0,
    timestamp: Date.now(),
  };
}

function countApiCalls(lines: string[]): number {
  let count = 0;
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      // 每个 assistant 消息代表一次 API 调用
      if (e.type === 'assistant') {
        count++;
      }
    } catch {
      // 跳过
    }
  }
  return count;
}

/**
 * 从 trace 中提取工具调用序列 (用于模式匹配)
 */
export function getToolSequence(trace: ExecutionTrace): string[] {
  return trace.timeline
    .filter((item): item is ToolCall => 'name' in item)
    .map((tc) => tc.name);
}

/**
 * 检查工具序列是否匹配模式 (正则表达式)
 */
export function matchToolPattern(
  trace: ExecutionTrace,
  pattern: string
): boolean {
  const sequence = getToolSequence(trace).join(',');
  const regex = new RegExp(pattern);
  return regex.test(sequence);
}
