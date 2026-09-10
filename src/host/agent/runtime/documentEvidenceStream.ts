import type { Message } from '../../../shared/contract';
import { checkDocumentEvidenceClaims } from './documentEvidenceBoundary';
import { createHandoffTailStreamFilter } from '../../handoff/handoffStream';

/**
 * 强终止符：只在整句结束处切。**不能**切逗号——限定语常常跟在「，」之后
 * （「空间主人：owner-fixture，尚未核实。」），从逗号切会把限定语劈到下一段去，
 * 让前半句在判定时看起来像个光秃秃的断言。
 */
const STRONG_BOUNDARY = /[。！？；\n]|[.!?;](?=\s|$)/g;

function lastStrongBoundary(text: string): number {
  STRONG_BOUNDARY.lastIndex = 0;
  let last = -1;
  for (const match of text.matchAll(STRONG_BOUNDARY)) {
    if (match.index !== undefined) last = match.index + match[0].length - 1;
  }
  return last;
}

/**
 * 按句流出的正文流。
 *
 * 边界检查是**记录式**的（2026-09-11 爸拍板）：只统计问题、不改写正文、不拦工具、不打回。
 * 误伤的代价因此从「毁掉整段回答」降到「trace 里多一行」，也正因为不再改写，才可以边收边发——
 * 攒到一个整句就发一段，40 秒的回答不会变成 40 秒空气泡（ai-review #1740）。
 *
 * 仍然保留的两条：handoff 尾巴不外泄；未完成（取消/抛错）的尾句不发布——
 * 半句话的判定和呈现都没有意义，且调用方已经把原始 chunk 存进 turn 供 abort 时留底。
 */
export function createDocumentEvidenceStream(messages: readonly Message[], emit: (text: string) => void): {
  push(text: string | undefined): void;
  finish(content: string | undefined): void;
  readonly pending: string;
  readonly problems: string[];
} {
  let raw = '';
  let visible = '';
  let published = '';
  const problems = new Set<string>();
  const handoff = createHandoffTailStreamFilter((text) => { visible += text; });

  const flush = (all: boolean) => {
    const cut = all ? visible.length - 1 : lastStrongBoundary(visible);
    if (cut < 0) return;
    const head = visible.slice(0, cut + 1);
    visible = visible.slice(cut + 1);
    published += head;
    for (const problem of checkDocumentEvidenceClaims(head, messages)) problems.add(problem);
    if (head) emit(head);
  };

  return {
    get pending() { return raw.slice(published.length); },
    get problems() { return [...problems]; },
    push(text) {
      raw += text ?? '';
      handoff.push(text ?? '');
      flush(false);
    },
    finish(content) {
      if (content !== undefined && content !== raw) {
        // 权威正文与拼接结果不一致（provider 做过收尾整理）：把差额补进可见缓冲再收尾。
        const extra = content.startsWith(published) ? content.slice(published.length + visible.length) : '';
        if (extra) handoff.push(extra);
      }
      handoff.flush();
      flush(true);
      raw = '';
      visible = '';
      published = '';
    },
  };
}
