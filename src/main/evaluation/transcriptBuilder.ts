// ============================================================================
// Transcript Builder - 构建结构化 Transcript 文本
// ============================================================================

import type { SessionSnapshot } from './types';

/**
 * 构建结构化 Transcript 文本（v3: 按 turn 分组）
 */
export function buildStructuredTranscript(snapshot: SessionSnapshot): string | null {
  // 优先使用 turns 结构
  if (snapshot.turns.length > 0) {
    return buildFromTurns(snapshot);
  }

  // Fallback: 从 messages 构建
  return buildFromMessages(snapshot);
}

/**
 * 从 turns 构建结构化 Transcript
 * 智能截断：保留首轮完整 + 末尾 3 轮完整 + 中间摘要
 */
export function buildFromTurns(snapshot: SessionSnapshot): string | null {
  if (snapshot.turns.length === 0) return null;

  const maxChars = 15000;

  // 先构建每轮的文本
  const turnTexts: string[] = [];
  for (const turn of snapshot.turns) {
    const parts: string[] = [];
    parts.push(`=== Turn ${turn.turnNumber} [${turn.intentPrimary}] ===`);

    let userContent = turn.userPrompt;
    if (userContent.length > 1000) {
      userContent = userContent.substring(0, 1000) + '...[截断]';
    }
    parts.push(`【用户】\n${userContent}`);

    if (turn.toolCalls.length > 0) {
      parts.push('【工具调用】');
      for (const tc of turn.toolCalls) {
        const status = tc.success ? '✓' : '✗';
        const parallel = tc.parallel ? ' [并行]' : '';
        parts.push(`  ${status} ${tc.name}${parallel} (${tc.duration}ms)`);
      }
    }

    let assistantContent = turn.assistantResponse;
    if (assistantContent.length > 1500) {
      assistantContent = assistantContent.substring(0, 1500) + '...[截断]';
    }
    parts.push(`【助手】\n${assistantContent}`);
    parts.push(`[结果: ${turn.outcomeStatus}]`);
    parts.push('---');

    turnTexts.push(parts.join('\n'));
  }

  const fullText = turnTexts.join('\n');
  if (fullText.length <= maxChars) return fullText;

  // 智能截断：保留首轮 + 末尾 3 轮 + 中间摘要
  const firstTurn = turnTexts[0];
  const lastThreeStart = Math.max(1, turnTexts.length - 3);
  const lastThree = turnTexts.slice(lastThreeStart);
  const middleTurns = snapshot.turns.slice(1, lastThreeStart);
  const middleToolCalls = middleTurns.reduce((sum, t) => sum + t.toolCalls.length, 0);

  const summary = `\n[... 省略 ${middleTurns.length} 轮对话，共 ${middleToolCalls} 次工具调用 ...]\n`;
  const truncatedText = [firstTurn, summary, ...lastThree].join('\n');

  // 添加截断上下文提示
  const header = `[注意: 原始对话共 ${snapshot.turns.length} 轮，因长度限制已智能截断，保留首轮和最后 ${lastThree.length} 轮]\n\n`;
  return header + truncatedText;
}

/**
 * Fallback: 从 messages 构建纯文本
 * 智能截断：保留首尾消息 + 中间摘要
 */
export function buildFromMessages(snapshot: SessionSnapshot): string | null {
  const messages = snapshot.messages;
  if (messages.length < 2) return null;

  const maxChars = 12000;

  // 先构建每条消息的文本
  const msgTexts: string[] = [];
  for (const msg of messages) {
    const role = msg.role === 'user' ? '用户' : '助手';
    let content = msg.content;
    if (content.length > 1500) {
      content = content.substring(0, 1500) + '...[截断]';
    }
    msgTexts.push(`【${role}】\n${content}\n---`);
  }

  const fullText = msgTexts.join('\n');
  if (fullText.length <= maxChars) return fullText;

  // 智能截断：保留前 2 条 + 后 4 条 + 中间摘要
  const headCount = 2;
  const tailCount = Math.min(4, messages.length - headCount);
  const tailStart = messages.length - tailCount;
  const head = msgTexts.slice(0, headCount);
  const tail = msgTexts.slice(tailStart);
  const middleCount = messages.length - headCount - tailCount;

  const summary = `\n[... 省略 ${middleCount} 条消息 ...]\n`;
  const header = `[注意: 原始对话共 ${messages.length} 条消息，因长度限制已智能截断]\n\n`;
  return header + [...head, summary, ...tail].join('\n');
}
