// ============================================================================
// Context Composition - 上下文来源桶「当前态」构成算法（N-CTXCURRENT）
//
// 语义（2026-08-21 爸拍板）：bySource 每桶 = 「当前装进模型的构成」，
// 从当前消息列表 + systemPrompt + 当前挂载 skills 重算，不是运行时累计账。
// 重算路径（resolveContextHealthForSession）与运行时路径（updateContextHealth）
// 都经 ContextHealthService.update() 汇入本函数，两条路径共用同一算法。
//
// 各桶取数来源：
//   rules      = systemPrompt / 持久化 system 消息里的 <agents-instructions> 段估算
//   skills     = 调用方传入的「当前挂载 skill → promptContent token 估算」
//   mcp        = 消息历史里 MCP 工具（mcp__server__tool / legacy mcp_server_tool）
//                的调用参数 + 结果内容，按 server 名归桶
//   subagents  = Task / spawn_agent 类调用的参数 + 结果内容，按子代理名归桶
//   fileReads  = Read 类调用的参数 + 结果内容
//   summary    = 带 compaction 标记的摘要消息 content 估算（沿用 N-CTXPANEL）
//   conversation = 扣减法：消息+工具结果总量 − 以上各桶，保持弹层九桶合计=总量
// ============================================================================

import type { ToolCall } from '../../shared/contract';
import type { CompactionBlock } from '../../shared/contract/message';
import {
  createEmptySourceBreakdown,
  type SourceBreakdown,
} from '../../shared/contract/contextHealth';
import { estimateConversationTokens, estimateTokens } from './tokenEstimator';

/**
 * 构成算法的消息最小形状。与 ContextHealthService 的 ContextMessage 同构
 * （service 侧直接 alias 本类型），toolResults 需要带 toolCallId 才能按工具名归桶。
 */
interface CompositionToolResult {
  toolCallId?: string;
  output?: string;
  error?: string;
}

export interface CompositionMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolResults?: CompositionToolResult[];
  /** 压缩摘要消息标记（compactionService 构造的 CompactionBlock），用于 summary 分桶 */
  compaction?: CompactionBlock;
}

/** 调用方解析好的「当前挂载 skill → token 估算」 */
export interface SourceCompositionHints {
  skills?: Array<{ name: string; tokens: number }>;
}

// ----------------------------------------------------------------------------
// 工具命名形态（已在仓内核实，测试钉住）：
//   MCP：mcp__<server>__<tool>（mcpToolRegistry 现行），legacy mcp_<server>_<tool>
//   Read 类：'Read'（read.schema.ts 注册名）；DB 历史里混用 'read_file' 等变体，
//     与 renderer humanizeToolStep.READ_TOOLS 同一份清单
//   子代理类：'Task'（task.schema.ts）/ 'spawn_agent'（spawnAgent.schema.ts）
//     及协议别名 'AgentSpawn'/'agentspawn'（toolNames.canonicalToolName）、'Explore'
// ----------------------------------------------------------------------------

const FILE_READ_TOOL_NAMES = new Set(['Read', 'read_file', 'read_pdf', 'read_xlsx', 'ReadDocument']);
const SUBAGENT_TOOL_NAMES = new Set(['Task', 'spawn_agent', 'AgentSpawn', 'agentspawn', 'Explore']);

type ToolBucket = { kind: 'mcp'; server: string } | { kind: 'subagent'; name: string } | { kind: 'fileReads' };

/** 解析 MCP 工具名（现行 mcp__server__tool，历史遗留 mcp_server_tool），口径同 externalSideEffect */
function parseMcpToolName(fullName: string): { server: string } | null {
  if (fullName.startsWith('mcp__')) {
    const rest = fullName.slice('mcp__'.length);
    const idx = rest.indexOf('__');
    if (idx <= 0) return null;
    return { server: rest.slice(0, idx) };
  }
  const legacy = /^mcp_([^_]+)_(.+)$/.exec(fullName);
  if (legacy) return { server: legacy[1] };
  return null;
}

function classifyToolCall(call: ToolCall): ToolBucket | null {
  const name = call.name || '';
  const mcp = parseMcpToolName(name);
  if (mcp) return { kind: 'mcp', server: mcp.server };
  if (FILE_READ_TOOL_NAMES.has(name)) return { kind: 'fileReads' };
  if (SUBAGENT_TOOL_NAMES.has(name)) {
    const args = call.arguments ?? {};
    const subagentName =
      (typeof args.subagent_type === 'string' && args.subagent_type) ||
      (typeof args.agentId === 'string' && args.agentId) ||
      (typeof args.role === 'string' && args.role) ||
      name;
    return { kind: 'subagent', name: subagentName };
  }
  return null;
}

function addBucketTokens(breakdown: SourceBreakdown, bucket: ToolBucket, tokens: number): void {
  if (tokens <= 0) return;
  switch (bucket.kind) {
    case 'mcp':
      breakdown.mcp[bucket.server] = (breakdown.mcp[bucket.server] ?? 0) + tokens;
      break;
    case 'subagent':
      breakdown.subagents[bucket.name] = (breakdown.subagents[bucket.name] ?? 0) + tokens;
      break;
    case 'fileReads':
      breakdown.fileReads += tokens;
      break;
  }
}

/** toolCall 的 token 文本口径：name + shortDescription + 参数 JSON（与原 service 私有实现一致） */
function toolCallTokenText(call: ToolCall): string {
  let args: string;
  try {
    args = JSON.stringify(call.arguments ?? {});
  } catch {
    args = String(call.arguments ?? '');
  }
  return [call.name, call.shortDescription || '', args].filter(Boolean).join('\n');
}

function toolResultTokens(result: CompositionToolResult): number {
  const text = [result.output ?? '', result.error ?? ''].filter(Boolean).join('\n');
  return text ? estimateTokens(text) : 0;
}

/**
 * 定位 AGENTS.md 注入段。注入路径：agentsHooks 组装 <agents-instructions>…</agents-instructions>，
 * 经 SessionStart hook 包进 <session-start-hook> 后以 role='system' 消息持久化；
 * 老路径/注入进 systemPrompt 的场景兜底扫 systemPrompt 字符串。只取第一份（每 session 只注入一次）。
 */
function extractAgentsInstructionsBlock(messages: CompositionMessage[], systemPrompt: string): string | null {
  const pattern = /<agents-instructions>[\s\S]*?<\/agents-instructions>/;
  for (const message of messages) {
    if (message.role !== 'system' || !message.content) continue;
    const match = pattern.exec(message.content);
    if (match) return match[0];
  }
  const fromPrompt = pattern.exec(systemPrompt);
  return fromPrompt ? fromPrompt[0] : null;
}

/**
 * 消息历史的 token 数（不含工具结果）：非 tool 消息正文 + assistant toolCalls 参数。
 * 与原 ContextHealthService.calculateMessagesTokens + calculateToolCallTokens 同口径。
 */
export function compositionMessagesTokens(messages: CompositionMessage[]): number {
  const nonToolMessages = messages
    .filter((msg) => msg.role !== 'tool')
    .map((msg) => ({
      role: msg.role as 'user' | 'assistant' | 'system',
      content: msg.content,
    }));
  let total = estimateConversationTokens(nonToolMessages);
  for (const message of messages) {
    if (!message.toolCalls?.length) continue;
    for (const toolCall of message.toolCalls) {
      total += estimateTokens(toolCallTokenText(toolCall));
    }
  }
  return total;
}

/**
 * 工具结果的 token 数：role=tool 消息的 content（已是 toolResults 的 JSON 序列化，
 * 不再计 toolResults 数组，避免双计）。与原 calculateToolResultsTokens 同口径。
 */
export function compositionToolResultsTokens(messages: CompositionMessage[]): number {
  let total = 0;
  for (const message of messages) {
    if (message.role === 'tool') {
      total += estimateTokens(message.content);
    }
  }
  return total;
}

/**
 * 当前态构成：从消息列表 + systemPrompt + 挂载 skills 重算 bySource。
 * 纯函数，不写任何状态；调用方每轮传入当前快照。
 */
export function computeSourceBreakdown(
  messages: CompositionMessage[],
  systemPrompt: string,
  hints?: SourceCompositionHints,
): SourceBreakdown {
  const breakdown = createEmptySourceBreakdown();

  // rules：AGENTS.md 注入段（持久化 system 消息优先，systemPrompt 兜底）
  const rulesBlock = extractAgentsInstructionsBlock(messages, systemPrompt);
  breakdown.rules = rulesBlock ? estimateTokens(rulesBlock) : 0;

  // skills：当前挂载列表（调用方解析 promptContent 估算）
  for (const skill of hints?.skills ?? []) {
    if (skill.tokens > 0) {
      breakdown.skills[skill.name] = skill.tokens;
    }
  }

  // summary：压缩摘要消息（带 compaction 标记）
  for (const message of messages) {
    if (message.compaction) {
      breakdown.summary += estimateTokens(message.content);
    }
  }

  // mcp / subagents / fileReads：扫消息历史按工具名归类
  // 第一遍：assistant toolCalls（参数计入对应桶，并登记 toolCallId → 桶 映射）
  const callBuckets = new Map<string, ToolBucket>();
  for (const message of messages) {
    if (!message.toolCalls?.length) continue;
    for (const call of message.toolCalls) {
      const bucket = classifyToolCall(call);
      if (!bucket) continue;
      addBucketTokens(breakdown, bucket, estimateTokens(toolCallTokenText(call)));
      callBuckets.set(call.id, bucket);
    }
  }
  // 第二遍：tool 结果按 toolCallId 归桶；映射不到的留在 conversation（扣减剩余）
  for (const message of messages) {
    if (message.toolResults?.length) {
      for (const result of message.toolResults) {
        const bucket = result.toolCallId ? callBuckets.get(result.toolCallId) : undefined;
        if (bucket) addBucketTokens(breakdown, bucket, toolResultTokens(result));
      }
      continue;
    }
    // role=tool 且没有结构化 toolResults 时，content 是结果数组的 JSON 序列化，解析归桶
    if (message.role === 'tool' && message.content) {
      try {
        const parsed: unknown = JSON.parse(message.content);
        if (!Array.isArray(parsed)) continue;
        for (const entry of parsed as CompositionToolResult[]) {
          const bucket = entry?.toolCallId ? callBuckets.get(entry.toolCallId) : undefined;
          if (bucket) addBucketTokens(breakdown, bucket, toolResultTokens(entry));
        }
      } catch {
        // 非 JSON 的 tool content：无法归因，留在 conversation
      }
    }
  }

  // conversation：扣减法。基底 = 消息正文+参数 + 工具结果总量，减掉所有来源桶，
  // 保持弹层九桶（systemPrompt/toolDefs 结构桶 + bySource 七桶）合计 = 估算总量。
  // rules/skills 物理上住在 systemPrompt 里，但从对话基底扣除是 N-CTXPANEL 定稿的
  // 混合维度口径（规则/技能行是对固定开销的归因展开，对话行只装剩余）。
  const attributed =
    breakdown.rules +
    Object.values(breakdown.skills).reduce((a, b) => a + b, 0) +
    Object.values(breakdown.mcp).reduce((a, b) => a + b, 0) +
    Object.values(breakdown.subagents).reduce((a, b) => a + b, 0) +
    breakdown.fileReads +
    breakdown.summary;
  const conversationBase = compositionMessagesTokens(messages) + compositionToolResultsTokens(messages);
  breakdown.conversation = Math.max(0, conversationBase - attributed);

  return breakdown;
}
