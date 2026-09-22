import { COMPANION_LIMITS } from '../../../shared/constants/companion';

/**
 * 引擎中断时写进助手正文的协议标记（conversationRuntime 的 [cancelled] / [未完成 — 切换会话中断] / [已被新消息打断]，
 * systemContextStack 的两个「部分回答已保留」）。桌面在渲染层消费它们，手机拿到的是原始正文 ⇒ 真机上出现一条
 * 只写着 [cancelled] 的助手消息（爸 2026-09-16 build 47）。出手机边界前剥掉；中断本身由执行结果行说明。
 */
const INTERRUPTION_MARKER = /\s*\[(?:cancelled|未完成\s*[—-]\s*切换会话中断|已被新消息打断|(?:连接中断|生成中断)\s*[—-]\s*部分回答已保留)\]/giu;
export function stripInterruptionMarkers(content: string): string {
  return content.replace(INTERRUPTION_MARKER, '');
}

function clip(text: string): string {
  return text.length > COMPANION_LIMITS.messageLength ? text.slice(0, COMPANION_LIMITS.messageLength) : text;
}

/** Export only the mobile projection, never raw tool arguments or diagnostics. */
export function projectCompanionEvent(kind: string, value: unknown): Record<string, unknown> | null {
  if (kind === 'run_started' || kind === 'agent_complete' || kind === 'agent_cancelled') return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  switch (kind) {
    case 'message':
      if (!['user', 'assistant'].includes(String(event.role)) || typeof event.id !== 'string' || typeof event.content !== 'string' || event.isMeta === true) return null;
      {
        const content = event.role === 'assistant' ? stripInterruptionMarkers(event.content) : event.content;
        // 只剩标记的助手消息（工具流中断也会落标记）不发：手机上不该出现一条空白或只有标记的气泡
        if (event.role === 'assistant' && !content.trim() && event.content.trim()) return null;
        return { id: event.id, role: event.role, content: clip(content) };
      }
    case 'message_delta':
      if (event.path !== 'content' || event.role !== 'assistant' || typeof event.text !== 'string' || !['append', 'replace'].includes(String(event.op))) return null;
      return { role: 'assistant', path: 'content', op: event.op, text: clip(event.text),
        ...(typeof event.messageId === 'string' ? { messageId: event.messageId } : {}),
        ...(typeof event.turnId === 'string' ? { turnId: event.turnId } : {}),
      };
    case 'message_snapshot':
      if (typeof event.content !== 'string') return null;
      return { role: 'assistant', content: clip(stripInterruptionMarkers(event.content)),
        ...(typeof event.messageId === 'string' ? { messageId: event.messageId } : {}),
        ...(typeof event.turnId === 'string' ? { turnId: event.turnId } : {}),
      };
    case 'tool_call_start':
      return typeof event.id === 'string' && typeof event.name === 'string' ? { id: event.id, name: event.name } : null;
    case 'tool_call_end':
      return typeof event.toolCallId === 'string' && typeof event.success === 'boolean' ? { toolCallId: event.toolCallId, success: event.success } : null;
    case 'error': {
      const failure = event.failure && typeof event.failure === 'object' && !Array.isArray(event.failure)
        ? event.failure as { code?: unknown; kind?: unknown }
        : null;
      if (failure?.code === 'PROJECT_SOURCE_TRUST') {
        if (failure.kind === 'source_missing') return { code: 'PROJECT_SOURCE_MISSING' };
        if (failure.kind === 'identity_changed') return { code: 'PROJECT_SOURCE_CHANGED' };
        if (failure.kind === 'not_trusted') return { code: 'PROJECT_SOURCE_UNTRUSTED' };
      }
      if (failure?.code === 'MODEL_AUTH' || failure?.code === 'MODEL_UNAVAILABLE' || failure?.code === 'MODEL_QUOTA') {
        const marked = failure as { code: string; provider?: unknown; model?: unknown };
        return { code: marked.code,
          ...(typeof marked.provider === 'string' && typeof marked.model === 'string' ? { provider: marked.provider, model: marked.model } : {}) };
      }
      return { code: 'RUN_FAILED' };
    }
    case 'artifact_write_started': {
      if (typeof event.toolCallId !== 'string') return null;
      const raw = typeof event.filePath === 'string' ? event.filePath.replaceAll('\\', '/') : '';
      const name = raw.split('/').pop() ?? '';
      return name ? { status: 'generating', toolCallId: event.toolCallId, name } : null;
    }
    default: return null;
  }
}
