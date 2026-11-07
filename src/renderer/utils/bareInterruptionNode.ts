// 重载视图里「只剩中断标记」的助手行（用户在模型首字前停止 / 切换会话）：
// 正文被渲染层剥空，又没有 recovery 快照或工具节点承载中断信号，整轮会是一片空白。
// 这里为它补一个空正文节点，由 TraceNodeRenderer 按本地化“已停止”文案渲染。
import type { Message, StreamInterruptionReason } from '@shared/contract';
import type { TraceNode } from '@shared/contract/trace';
import { isStreamRecoveryMessage } from './streamRecoveryMessage';

const PROTOCOL_MARKERS = /\[cancelled\]|\[未完成\s*[—-]\s*切换会话中断\]/giu;

export function bareInterruptionNode(
  msg: Message,
  all: Message[],
  reason: StreamInterruptionReason,
): TraceNode | null {
  if (reason !== 'user' && reason !== 'session-switch') return null;
  if (isStreamRecoveryMessage(msg) || msg.toolCalls?.length) return null;
  if (msg.content.replace(PROTOCOL_MARKERS, '').trim()) return null;
  if (all.some((m) => isStreamRecoveryMessage(m))) return null;
  return {
    id: `${msg.id}-text`,
    messageId: msg.id,
    type: 'assistant_text',
    content: '',
    timestamp: msg.timestamp,
    metadata: { ...msg.metadata, streamInterruptionReason: reason },
  };
}
