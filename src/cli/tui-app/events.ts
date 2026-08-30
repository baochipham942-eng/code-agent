// ============================================================================
// Ink TUI 消息模型 + AgentEvent → 消息列表的纯函数 reducer
// 无 Ink 依赖，可单测；渲染层（MessageView.tsx）只消费这里产出的结构。
// ============================================================================

import type { AgentEvent } from '../../shared/contract';
import { MODEL_PRICING_PER_1M } from '../../shared/constants/pricing';
import { shellOutputPreview } from './shellOutput';

// ---------------------------------------------------------------------------
// 消息模型
// ---------------------------------------------------------------------------

interface UserMessage {
  id: string;
  kind: 'user';
  text: string;
}

interface AssistantMessage {
  id: string;
  kind: 'assistant';
  text: string;
  /** 流式累积中（stream_chunk 持续追加，message/agent_complete 事件封口） */
  streaming: boolean;
}

interface ThinkingMessage {
  id: string;
  kind: 'thinking';
  text: string;
  startedAt: number;
  /** 推理结束时间；undefined = 仍在推理。结束后保留耗时渲染 "Thought for Xs" */
  endedAt?: number;
}

export interface ToolCallItem {
  id: string;
  name: string;
  /** 进行时动词（Reading） */
  activeVerb: string;
  /** 完成时动词（Read） */
  doneVerb: string;
  /** 单行参数摘要 */
  summary: string;
  status: 'running' | 'done' | 'error';
  /** 完成后的单行结果预览 / 失败原因 */
  resultPreview?: string;
  /** 成功输出的截断展示行（前 2 + 后 3，shell 类工具才有；渲染层原样逐行显示） */
  outputLines?: string[];
  startedAt: number;
  durationMs?: number;
}

/** 同类连续调用归组（"Read 3 files"）；不参与归组的工具每次调用独立成组 */
export interface ToolGroupMessage {
  id: string;
  kind: 'tool_group';
  name: string;
  activeVerb: string;
  doneVerb: string;
  /** 归组量词（file/pattern/directory）；空 = 不归组 */
  groupNoun: string;
  calls: ToolCallItem[];
  status: 'running' | 'done' | 'error';
}

export interface SystemMessage {
  id: string;
  kind: 'system';
  tone: 'info' | 'warn' | 'error';
  text: string;
}

export type ChatMessage =
  | UserMessage
  | AssistantMessage
  | ThinkingMessage
  | ToolGroupMessage
  | SystemMessage;

export interface ChatState {
  messages: ChatMessage[];
  /** turn 是否在运行（驱动 Turn status 行） */
  running: boolean;
  /** 当前活动标签（Thinking… / Run command …） */
  activity: string | null;
  /** 本轮 turn 开始时间（Turn status 计时用） */
  turnStartedAt: number | null;
  inputTokens: number;
  outputTokens: number;
  model: string | null;
  provider: string | null;
  /** turn 计数（turn_start 的 iteration，缺省自增） */
  turns: number;
  /** 会话内调用过的工具名（去重计数用） */
  toolNames: string[];
  /** 上下文窗口占用 0-100（task_stats.contextUsage） */
  contextPercent: number | null;
  /** 上一 turn 耗时 ms（task_complete.duration） */
  lastTurnMs: number | null;
  /** 自增消息 id 计数（保证纯函数可复现） */
  nextId: number;
}

// ---------------------------------------------------------------------------
// 工具动词表（时态 + 归组策略，对齐交互规格）
// ---------------------------------------------------------------------------

interface ToolVerbSpec {
  active: string;
  done: string;
  /** 归组量词；不设 = 破坏性/动作类，不参与归组 */
  groupNoun?: string;
}

const TOOL_VERBS: Record<string, ToolVerbSpec> = {
  read_file: { active: 'Reading', done: 'Read', groupNoun: 'file' },
  grep: { active: 'Searching', done: 'Searched', groupNoun: 'pattern' },
  glob: { active: 'Finding', done: 'Found', groupNoun: 'file' },
  list_directory: { active: 'Listing', done: 'Listed', groupNoun: 'directory' },
  bash: { active: 'Running', done: 'Ran' },
  write_file: { active: 'Writing', done: 'Wrote' },
  append_file: { active: 'Appending', done: 'Appended' },
  edit_file: { active: 'Editing', done: 'Edited' },
  delete_file: { active: 'Deleting', done: 'Deleted' },
};

function verbSpec(name: string): ToolVerbSpec {
  return TOOL_VERBS[name] ?? { active: name, done: name };
}

/** 工具参数 → 单行摘要（策略对齐 terminal.ts 的 formatToolArgs） */
export function summarizeToolArgs(args: Record<string, unknown>): string {
  const truncate = (s: string, max = 60) => (s.length > max ? s.substring(0, max - 3) + '...' : s);
  if (args.path || args.file_path) {
    const p = String(args.path || args.file_path);
    const home = process.env.HOME || '';
    const short = home && p.startsWith(home) ? '~' + p.slice(home.length) : p;
    return truncate(short);
  }
  if (args.command) return truncate(String(args.command));
  if (args.pattern || args.query) return truncate(`"${String(args.pattern || args.query)}"`);
  if (args.skill_name || args.name) return truncate(String(args.skill_name || args.name));
  if (args.uri) return truncate(String(args.uri));
  const json = JSON.stringify(args);
  if (json && json !== '{}') return truncate(json);
  return '';
}

/** 耗时格式化：12.3s / 1m20s */
export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${seconds}s`;
}

/** 会话累计成本估算（USD，价表缺省走 default 档；逻辑同旧 tuiChat） */
export function estimateCostUsd(model: string | null, inputTokens: number, outputTokens: number): number {
  const pricing = (model && MODEL_PRICING_PER_1M[model]) || MODEL_PRICING_PER_1M['default'];
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}

// ---------------------------------------------------------------------------
// reducer
// ---------------------------------------------------------------------------

export function createChatState(): ChatState {
  return {
    messages: [],
    running: false,
    activity: null,
    turnStartedAt: null,
    inputTokens: 0,
    outputTokens: 0,
    model: null,
    provider: null,
    turns: 0,
    toolNames: [],
    contextPercent: null,
    lastTurnMs: null,
    nextId: 1,
  };
}

function takeId(state: ChatState): [string, ChatState] {
  return [`m${state.nextId}`, { ...state, nextId: state.nextId + 1 }];
}

function withMessage(state: ChatState, message: ChatMessage): ChatState {
  return { ...state, messages: [...state.messages, message] };
}

function replaceLastMessage(state: ChatState, message: ChatMessage): ChatState {
  if (state.messages.length === 0) return state;
  return { ...state, messages: [...state.messages.slice(0, -1), message] };
}

/** 推理流结束封口（保留耗时）：任何非 stream_reasoning 事件到来都视为推理结束 */
function sealThinking(state: ChatState, now: number): ChatState {
  const last = state.messages[state.messages.length - 1];
  if (last?.kind === 'thinking' && last.endedAt === undefined) {
    return replaceLastMessage(state, { ...last, endedAt: now });
  }
  return state;
}

/** 流式 assistant 消息封口 */
function sealAssistant(state: ChatState): ChatState {
  const last = state.messages[state.messages.length - 1];
  if (last?.kind === 'assistant' && last.streaming) {
    return replaceLastMessage(state, { ...last, streaming: false });
  }
  return state;
}

/** 追加用户输入（提交时由 UI 调用，不走事件流） */
export function appendUserMessage(state: ChatState, text: string): ChatState {
  const [id, next] = takeId(state);
  return withMessage(next, { id, kind: 'user', text });
}

/** 追加系统提示（错误/状态/本地 slash 命令回显） */
export function appendSystemMessage(state: ChatState, text: string, tone: SystemMessage['tone'] = 'info'): ChatState {
  const [id, next] = takeId(state);
  return withMessage(next, { id, kind: 'system', tone, text });
}

/** 提交一轮：标记运行中并开始计时 */
export function markRunStarted(state: ChatState, now: number = Date.now()): ChatState {
  return { ...state, running: true, activity: 'Thinking…', turnStartedAt: now };
}

// ---------------------------------------------------------------------------
// `!` shell 直通的消息块（不走 agent 事件流，UI 直接追加/收口）
// ---------------------------------------------------------------------------

export interface ShellCommandResult {
  success: boolean;
  output?: string;
  error?: string;
}

/** 追加一条进行中的 bash 工具块，返回消息 id 供 resolveShellCommand 收口 */
export function appendShellCommand(
  state: ChatState,
  command: string,
  now: number = Date.now(),
): [ChatState, string] {
  const [id, next] = takeId(state);
  const call: ToolCallItem = {
    id: `shell-${id}`,
    name: 'bash',
    activeVerb: 'Running',
    doneVerb: 'Ran',
    summary: command,
    status: 'running',
    startedAt: now,
  };
  const message: ToolGroupMessage = {
    id,
    kind: 'tool_group',
    name: 'bash',
    activeVerb: 'Running',
    doneVerb: 'Ran',
    groupNoun: '',
    calls: [call],
    status: 'running',
  };
  return [withMessage(next, message), id];
}

/** 用执行结果收口 appendShellCommand 追加的进行中工具块；找不到消息时原样返回 */
export function resolveShellCommand(
  state: ChatState,
  messageId: string,
  result: ShellCommandResult,
  now: number = Date.now(),
): ChatState {
  const index = state.messages.findIndex((m) => m.id === messageId && m.kind === 'tool_group');
  if (index < 0) return state;
  const message = state.messages[index] as ToolGroupMessage;
  const call = message.calls[0];
  if (call?.status !== 'running') return state;
  const status: ToolCallItem['status'] = result.success ? 'done' : 'error';
  const rawPreview = result.success ? (result.output ?? '') : (result.error ?? 'failed');
  const updatedCall: ToolCallItem = {
    ...call,
    status,
    resultPreview: rawPreview.replace(/\s+/g, ' ').trim().slice(0, 80) || undefined,
    outputLines: result.success && result.output ? shellOutputPreview(result.output) : undefined,
    durationMs: now - call.startedAt,
  };
  const updated: ToolGroupMessage = { ...message, calls: [updatedCall], status };
  return { ...state, messages: [...state.messages.slice(0, index), updated, ...state.messages.slice(index + 1)] };
}

/** AgentEvent → 消息模型。now 可注入便于单测。 */
export function reduceAgentEvent(state: ChatState, event: AgentEvent, now: number = Date.now()): ChatState {
  switch (event.type) {
    case 'stream_chunk': {
      const content = event.data?.content;
      if (!content) return state;
      let next = sealThinking(state, now);
      const last = next.messages[next.messages.length - 1];
      if (last?.kind === 'assistant' && last.streaming) {
        return replaceLastMessage(next, { ...last, text: last.text + content });
      }
      const [id, withId] = takeId(next);
      next = withId;
      return withMessage(next, { id, kind: 'assistant', text: content, streaming: true });
    }

    case 'message': {
      const data = event.data;
      if (data?.role !== 'assistant') return state;
      let next = sealThinking(state, now);
      const last = next.messages[next.messages.length - 1];
      if (last?.kind === 'assistant' && last.streaming) {
        // 流式消息封口；流为空（非流式 provider）时用 message 正文兜底
        const text = last.text || data.content || '';
        return replaceLastMessage(next, { ...last, text, streaming: false });
      }
      if (!data.content) return next;
      const [id, withId] = takeId(next);
      next = withId;
      return withMessage(next, { id, kind: 'assistant', text: data.content, streaming: false });
    }

    case 'stream_reasoning': {
      const content = event.data?.content;
      if (!content) return state;
      const last = state.messages[state.messages.length - 1];
      if (last?.kind === 'thinking' && last.endedAt === undefined) {
        return replaceLastMessage(state, { ...last, text: last.text + content });
      }
      const [id, next] = takeId(state);
      return withMessage(next, { id, kind: 'thinking', text: content, startedAt: now });
    }

    case 'tool_call_start': {
      const data = event.data;
      if (!data?.name) return state;
      let next = sealThinking(state, now);
      const spec = verbSpec(data.name);
      const args = (data.arguments ?? {}) as Record<string, unknown>;
      const call: ToolCallItem = {
        id: data.id || `call-${next.nextId}`,
        name: data.name,
        activeVerb: spec.active,
        doneVerb: spec.done,
        summary: summarizeToolArgs(args),
        status: 'running',
        startedAt: now,
      };
      next = {
        ...next,
        activity: `${spec.active} ${call.summary}`.trim(),
        toolNames: next.toolNames.includes(data.name) ? next.toolNames : [...next.toolNames, data.name],
      };
      // 同类连续调用且允许归组 → 并入末尾同名片段
      const last = next.messages[next.messages.length - 1];
      if (spec.groupNoun && last?.kind === 'tool_group' && last.name === data.name) {
        const merged: ToolGroupMessage = {
          ...last,
          calls: [...last.calls, call],
          status: 'running',
        };
        return replaceLastMessage(next, merged);
      }
      const [id, withId] = takeId(next);
      next = withId;
      return withMessage(next, {
        id,
        kind: 'tool_group',
        name: data.name,
        activeVerb: spec.active,
        doneVerb: spec.done,
        groupNoun: spec.groupNoun ?? '',
        calls: [call],
        status: 'running',
      });
    }

    case 'tool_call_end': {
      const data = event.data;
      if (!data?.toolCallId) return state;
      // 从后往前找包含该调用的分组（正常都是最近一组）
      for (let i = state.messages.length - 1; i >= 0; i--) {
        const message = state.messages[i];
        if (message.kind !== 'tool_group') continue;
        const callIndex = message.calls.findIndex((c) => c.id === data.toolCallId);
        if (callIndex < 0) continue;
        const status: ToolCallItem['status'] = data.success ? 'done' : 'error';
        const rawPreview = data.success ? (data.output ?? '') : (data.error ?? 'failed');
        const resultPreview = rawPreview.replace(/\s+/g, ' ').trim().slice(0, 80) || undefined;
        // shell 成功输出此前完全不可见：按规格留前 2 + 后 3 行（含省略标记）
        const outputLines = data.success && data.output && message.name === 'bash'
          ? shellOutputPreview(data.output)
          : undefined;
        const calls = message.calls.map((c, j) => (j === callIndex
          ? { ...c, status, resultPreview, outputLines, durationMs: data.duration ?? now - c.startedAt }
          : c));
        const groupStatus: ToolGroupMessage['status'] = calls.some((c) => c.status === 'running')
          ? 'running'
          : calls.some((c) => c.status === 'error')
            ? 'error'
            : 'done';
        const updated: ToolGroupMessage = { ...message, calls, status: groupStatus };
        return { ...state, messages: [...state.messages.slice(0, i), updated, ...state.messages.slice(i + 1)] };
      }
      return state;
    }

    case 'task_progress': {
      const data = event.data;
      if (!data) return state;
      if (data.phase === 'completed' || data.phase === 'failed') {
        return { ...state, activity: null };
      }
      const label = data.step
        || (data.phase === 'thinking' ? 'Thinking…' : data.phase === 'tool_running' ? 'Run command' : 'Working…');
      return { ...state, running: true, activity: label };
    }

    case 'agent_thinking': {
      const message = event.data?.message;
      return message ? { ...state, activity: message } : state;
    }

    case 'tool_progress': {
      const data = event.data;
      if (!data) return state;
      return { ...state, activity: data.detail ? `${data.toolName}: ${data.detail}` : `Running ${data.toolName}` };
    }

    case 'turn_start': {
      const iteration = event.data?.iteration;
      const turns = iteration != null ? Math.max(state.turns, iteration) : state.turns + 1;
      return state.turnStartedAt == null
        ? { ...state, running: true, turnStartedAt: now, turns }
        : { ...state, running: true, turns };
    }

    case 'turn_end':
      return sealThinking(state, now);

    case 'task_complete': {
      const data = event.data;
      if (!data) return state;
      return { ...state, lastTurnMs: data.duration ?? state.lastTurnMs };
    }

    case 'task_stats': {
      const usage = event.data?.contextUsage;
      return usage != null ? { ...state, contextPercent: usage * 100 } : state;
    }

    case 'error': {
      let next = sealThinking(state, now);
      next = sealAssistant(next);
      return appendSystemMessage(next, event.data?.message || 'Unknown error', 'error');
    }

    case 'agent_complete':
    case 'agent_cancelled': {
      let next = sealThinking(state, now);
      next = sealAssistant(next);
      return { ...next, running: false, activity: null, turnStartedAt: null };
    }

    case 'stream_usage': {
      const data = event.data;
      if (!data) return state;
      return {
        ...state,
        inputTokens: state.inputTokens + (data.inputTokens || 0),
        outputTokens: state.outputTokens + (data.outputTokens || 0),
      };
    }

    case 'model_response': {
      const data = event.data;
      if (!data) return state;
      return {
        ...state,
        model: data.model || state.model,
        provider: data.provider || state.provider,
        inputTokens: state.inputTokens + (data.inputTokens || 0),
        outputTokens: state.outputTokens + (data.outputTokens || 0),
      };
    }

    case 'model_fallback': {
      const data = event.data;
      if (!data) return state;
      return appendSystemMessage(state, `Model fallback: ${data.from} → ${data.to} (${data.reason})`, 'warn');
    }

    case 'context_compacted': {
      const data = event.data;
      if (!data?.tokensBefore || !data.tokensAfter) return state;
      const before = `${(data.tokensBefore / 1000).toFixed(0)}k`;
      const after = `${(data.tokensAfter / 1000).toFixed(0)}k`;
      return appendSystemMessage(state, `⊘ Compacted: ${before} → ${after} tokens`);
    }

    case 'notification': {
      const message = event.data?.message;
      return message ? appendSystemMessage(state, message) : state;
    }

    default:
      return state;
  }
}
