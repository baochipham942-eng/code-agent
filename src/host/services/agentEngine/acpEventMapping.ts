// ============================================================================
// ACP session/update → Neo 归一事件的纯映射层
// ============================================================================
//
// 与 CLI 系 adapter 最大的不同：ACP 送来的已经是结构化状态机，不需要
// stream_json / jsonl / sse / text 四套文本解析。本文件只做「协议词 → Neo 词」，
// 不碰进程、不碰 IO，因此可被单测直接覆盖（反向变异的靶子就是这里）。
//
// 映射依据 = 2026-08-27 对 Kimi Code CLI 0.38.0 的真机抓包
// （code-agent-private-archive/docs/evidence/2026-08-27-N-ACP-CLIENT-事件流映射表.md）：
// 实测出现 7 种 sessionUpdate，SDK 1.4.0 全集 22 种，其余按 ignored 落日志不丢弃静默。

/** ACP 的 tool_call 状态机取值（SDK: ToolCallStatus）。 */
export type AcpToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export type AcpMappedEvent =
  /** agent_message_chunk → message_delta(path:'content') */
  | { kind: 'text'; text: string }
  /** agent_thought_chunk → message_delta(path:'reasoning') */
  | { kind: 'reasoning'; text: string }
  /** tool_call / tool_call_update → agent_engine.tool_call（按 toolCallId 聚合） */
  | { kind: 'tool_call'; toolCallId: string; title?: string; toolKind?: string; status?: AcpToolCallStatus }
  /** usage_update → 落 ledger，本刀不进 UI */
  | { kind: 'usage'; used?: number; size?: number }
  /**
   * 明确认得、但本刀不消费的更新。
   * 🔴 user_message_chunk 必须落在这里：session/load 回放历史时它会带着**用户自己**的话过来，
   * 若按 text 转成 message_delta 会把用户的输入渲染成助手输出（08-27 抓包实证：load 回放 9 条里就有 3 条）。
   */
  | { kind: 'ignored'; sessionUpdate: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/** ACP content block（`{type:'text',text}`）取文本；非 text 块返回空串。 */
function readContentText(content: unknown): string {
  if (!isRecord(content)) return '';
  if (content.type !== 'text') return '';
  return typeof content.text === 'string' ? content.text : '';
}

function readToolCallStatus(value: unknown): AcpToolCallStatus | undefined {
  return value === 'pending' || value === 'in_progress' || value === 'completed' || value === 'failed'
    ? value
    : undefined;
}

/**
 * 把一条 `session/update` 通知的 `update` 体映射成 Neo 归一事件。
 *
 * 返回 `null` 表示这条根本不是合法的 update（缺 sessionUpdate 判别字段）——
 * 与「认得但不消费」（`ignored`）是两件事，不要合并：前者是协议异常要记日志，
 * 后者是正常流量。
 */
export function mapAcpSessionUpdate(update: unknown): AcpMappedEvent | null {
  if (!isRecord(update)) return null;
  const sessionUpdate = update.sessionUpdate;
  if (typeof sessionUpdate !== 'string') return null;

  switch (sessionUpdate) {
    case 'agent_message_chunk': {
      const text = readContentText(update.content);
      return text ? { kind: 'text', text } : { kind: 'ignored', sessionUpdate };
    }
    case 'agent_thought_chunk': {
      const text = readContentText(update.content);
      return text ? { kind: 'reasoning', text } : { kind: 'ignored', sessionUpdate };
    }
    case 'tool_call':
    case 'tool_call_update': {
      const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : '';
      if (!toolCallId) return { kind: 'ignored', sessionUpdate };
      return {
        kind: 'tool_call',
        toolCallId,
        ...(typeof update.title === 'string' ? { title: update.title } : {}),
        ...(typeof update.kind === 'string' ? { toolKind: update.kind } : {}),
        ...(readToolCallStatus(update.status) ? { status: readToolCallStatus(update.status) } : {}),
      };
    }
    case 'usage_update':
      return {
        kind: 'usage',
        ...(typeof update.used === 'number' ? { used: update.used } : {}),
        ...(typeof update.size === 'number' ? { size: update.size } : {}),
      };
    default:
      return { kind: 'ignored', sessionUpdate };
  }
}

/**
 * tool_call 的显示名累积器：ACP 只在**部分** update 上带 title/kind
 * （抓包实测：首条 `tool_call` 带 `title:'Write'`，中间 16 条 `tool_call_update` 全是 null，
 * 直到快结束才又出现 `title:'Writing acp-probe-touch.txt'`）。
 * 台账要的是「这个工具叫什么」，所以按 toolCallId 记住最后一次非空的 title。
 */
export class AcpToolCallTracker {
  private readonly titles = new Map<string, string>();

  /** 返回该 toolCallId 当前最佳显示名；从没见过 title 时回落 toolCallId。 */
  observe(event: Extract<AcpMappedEvent, { kind: 'tool_call' }>): string {
    if (event.title) this.titles.set(event.toolCallId, event.title);
    return this.titles.get(event.toolCallId) ?? event.toolCallId;
  }

  /** 是否是该 toolCallId 的终态（completed/failed）。 */
  static isTerminal(status: AcpToolCallStatus | undefined): boolean {
    return status === 'completed' || status === 'failed';
  }
}
