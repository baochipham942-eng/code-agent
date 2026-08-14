// ============================================================================
// 通话字幕落库（从 voiceSessionService 原样搬出，行为零改动）
//
// 落库的唯一入口 = 过滤的唯一落点：done 那条、排水窗冲刷那条走的都是这里。
// ============================================================================

import { VOICE_TRANSCRIPT_MERGE_WINDOW_MS } from '../../../shared/constants/voice';
import { getSessionManager } from '../infra/sessionManager';
import { pushVoiceTranscript } from './voiceAgentCoordinator';
import { createLogger } from '../infra/logger';

const logger = createLogger('VoiceSession');

/**
 * 整条字幕只有工具标签（R6，2026-07-30 真机：模型把 `<end_call>` 当话「说」了出来）。
 *
 * 标签是模型和我们之间的暗号，不是说给用户听的话——不该上屏，也不该落进消息流。
 * 流式 delta 会给到半截标签（`<`、`<end_c`），所以闭合的 `>` 是可选的。
 * **标签混在正文里的不管**：那时正文才是这句话的内容，删标签等于改用户看到的话。
 */
const PURE_TOOL_TAG_TEXT = /^\s*(<[a-z0-9_]*>?\s*)+$/i;

export function isPureToolTagText(text: string): boolean {
  return PURE_TOOL_TAG_TEXT.test(text);
}

/**
 * 上一条落库的用户字幕（R5 合并用）。VAD 会把一句话切成几轮，消息流里就成了几条碎片。
 *
 * 合并是**落库后回头并入**，不是攒着晚点写：近窗（派活时执行侧重建意图的原文）、
 * 挂断闸、字幕 UI 全都吃这条 final 的到达时刻，晚 2 秒等于让紧跟的 delegate_task
 * 看不到用户最后那句话。所以照常立即写，下一条来得够快就把上一条改掉。
 */
export interface TranscriptMergeState {
  messageId: string | null;
  text: string;
  at: number;
}

export async function persistTranscript(
  neoSessionId: string,
  role: 'user' | 'assistant',
  text: string,
  counter?: { count: number },
  merge?: TranscriptMergeState,
  identity?: { responseId?: string; itemId?: string },
): Promise<void> {
  const trimmed = text.trim();
  // 丢弃必须出声（E1 硬要求）：静默丢弃就是「用户说了话、系统什么都没留下、日志一个字都没有」，
  // 本仓已为此付过一次数据丢失。只记 role 和原因，不记内容。
  if (!trimmed || isPureToolTagText(trimmed)) {
    logger.warn('transcript dropped before persist', {
      role,
      reason: trimmed ? 'pure-tool-tag' : 'empty-text',
    });
    return;
  }
  // 落库的同时进近窗（P0-2）：派活时执行侧要拿原文自己重建意图，
  // 别只给它通话 brain 改写过的那一句。落库失败不影响近窗，反之亦然。
  // ponytail: 合并只改消息流不回收近窗——近窗是喂模型的，碎一点无害（产品拍板）。
  pushVoiceTranscript({ role, text: trimmed });
  const now = Date.now();
  // ponytail: 上一条还在写库时（messageId 尚未回填）就直接不合并，各落各的——
  // 真机上两条 final 至少隔一个 VAD 静音窗，插入早完成了；退化路径也只是多一条消息。
  const mergeable = role === 'user'
    && merge?.messageId
    && now - merge.at < VOICE_TRANSCRIPT_MERGE_WINDOW_MS;
  try {
    if (mergeable && merge?.messageId) {
      const merged = `${merge.text} ${trimmed}`;
      await getSessionManager().updateMessage(merge.messageId, { content: merged });
      merge.text = merged;
      merge.at = now;
      // 合并进上一条 = 消息没多一条，transcriptCount 也不该多一个。
      return;
    }
    const id = `voice-${role}-${now}-${Math.random().toString(36).slice(2, 8)}`;
    await getSessionManager().addMessageToSession(neoSessionId, {
      id,
      role,
      content: trimmed,
      timestamp: now,
      metadata: {
        source: 'voice',
        ...(identity && (identity.responseId || identity.itemId) ? { voiceTranscript: identity } : {}),
      },
    });
    if (counter) counter.count += 1;
    // 助手说过话之后用户再开口，那是新的一轮，不能再往上一条里并。
    if (merge) {
      merge.messageId = role === 'user' ? id : null;
      merge.text = trimmed;
      merge.at = now;
    }
  } catch (err) {
    logger.warn('failed to persist transcript', { role, message: err instanceof Error ? err.message : 'unknown' });
  }
}
