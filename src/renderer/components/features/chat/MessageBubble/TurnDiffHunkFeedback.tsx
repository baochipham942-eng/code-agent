// ============================================================================
// TurnDiffHunkFeedback - 改动卡展开后的块级反馈：列出改动块，点一块写一句话
// 直接发进当前会话，模型只改那一个块——不用整轮撤销，也不用用户手打路径行号。
//
// 与 LocalityFeedbackBar 同一形态（单行输入回车发送），但**不带 localityAnchor**：
// host 的 upgradeLegacyAnchor / 写前 guard 只理解产物坐标，代码行没有 revision 可
// 对账。这是一次性消息，不是持久评论线程（locality-feedback 设计文档已否决 diff
// 评论系统）。只在权威 diff（磁盘整文件文本）下渲染，行号才是真文件行号。
// ============================================================================

import React, { useCallback, useMemo, useState } from 'react';
import { Send } from 'lucide-react';
import { Button } from '../../../primitives';
import { useMessageActionStore } from '../../../../stores/messageActionStore';
import { useI18n } from '../../../../hooks/useI18n';
import { buildTurnDiffHunks, type TurnDiffHunk } from '../../../../utils/turnDiffHunks';
import { buildDiffHunkFeedbackMessage } from '@shared/livePreview/localityFeedback';

type Props = {
  filePath: string;
  /** 权威 diff 的整文件旧/新文本（非权威的片段行号不是文件行号，入口不渲染本组件） */
  oldText: string;
  newText: string;
};

export const TurnDiffHunkFeedback: React.FC<Props> = ({ filePath, oldText, newText }) => {
  const { t } = useI18n();
  const sendPrompt = useMessageActionStore((s) => s.sendPrompt);
  const hunks = useMemo(() => buildTurnDiffHunks(oldText, newText), [oldText, newText]);
  const [activeHunk, setActiveHunk] = useState<TurnDiffHunk | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  const submit = useCallback(async () => {
    const feedback = text.trim();
    if (!feedback || !activeHunk || sending) return;
    setSending(true);
    try {
      await sendPrompt(
        buildDiffHunkFeedbackMessage(
          {
            filePath,
            startLine: activeHunk.startLine,
            endLine: activeHunk.endLine,
            excerpt: activeHunk.excerpt,
            deletionAnchor: activeHunk.deletionAnchor,
          },
          feedback,
        ),
      );
      // 发出即收：反馈是一次性消息，输入行清空并收起，不残留成常驻评论框
      setText('');
      setActiveHunk(null);
    } finally {
      setSending(false);
    }
  }, [activeHunk, filePath, sending, sendPrompt, text]);

  const linesLabel = (hunk: TurnDiffHunk): string => {
    // 纯删除块的行号不是「被改的行」：中部删除显示插入点，文件尾删除显示末尾，
    // 不能让 UI 把锚行说成可点改的行号（锚行没被改过）。
    if (hunk.deletionAnchor === 'after') return t.turnDiff.hunkLinesFileEnd;
    if (hunk.deletionAnchor === 'before') {
      return t.turnDiff.hunkLinesBefore.replace('{line}', String(hunk.startLine));
    }
    return hunk.startLine === hunk.endLine
      ? t.turnDiff.hunkLinesSingle.replace('{line}', String(hunk.startLine))
      : t.turnDiff.hunkLinesRange
          .replace('{start}', String(hunk.startLine))
          .replace('{end}', String(hunk.endLine));
  };

  const openFeedback = (hunk: TurnDiffHunk): void => {
    // 半句话不跟人走：草稿是针对某一块写的，换块 = 换对象，清零重来，
    // 否则块 1 的半句会按块 2 的行号发出去。
    if (activeHunk?.index !== hunk.index) {
      setActiveHunk(hunk);
      setText('');
    }
  };

  if (hunks.length === 0) return null;

  return (
    <div data-testid="turn-diff-hunk-list" className="mt-2">
      <div className="text-[11px] font-medium text-zinc-500">{t.turnDiff.hunkListTitle}</div>
      <ul className="mt-1 space-y-1">
        {hunks.map((hunk) => (
          <li key={hunk.index}>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-zinc-400">
                {t.turnDiff.hunkBlockLabel.replace('{index}', String(hunk.index))}
              </span>
              <span className="font-mono text-[11px] text-zinc-500">{linesLabel(hunk)}</span>
              {hunk.added > 0 && (
                <span className="text-[11px] text-badge-success">+{hunk.added}</span>
              )}
              {hunk.removed > 0 && (
                <span className="text-[11px] text-badge-danger">−{hunk.removed}</span>
              )}
              <Button
                variant="ghost"
                size="sm"
                data-testid="hunk-comment-btn"
                title={t.turnDiff.hunkCommentTitle}
                onClick={() => openFeedback(hunk)}
                className="h-auto px-2! py-0.5! gap-1! text-[11px]!"
              >
                {t.turnDiff.hunkComment}
              </Button>
            </div>
            {activeHunk?.index === hunk.index && (
              <div className="mt-1 flex items-center gap-2">
                <input
                  data-testid="hunk-feedback-input"
                  type="text"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      void submit();
                    }
                  }}
                  placeholder={t.turnDiff.hunkPlaceholder}
                  disabled={sending}
                  autoFocus
                  className="flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 placeholder-zinc-500 focus:border-badge-info focus:outline-none disabled:opacity-60"
                />
                <Button
                  variant="secondary"
                  size="sm"
                  data-testid="hunk-send-btn"
                  onClick={() => void submit()}
                  disabled={sending || !text.trim()}
                  leftIcon={<Send className="h-3 w-3" />}
                  className="h-auto px-2! py-1! gap-1! text-[11px]!"
                >
                  {sending ? t.turnDiff.hunkSending : t.turnDiff.hunkSend}
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
};
