// 定点反馈栏（可复用）— PPT 某页 / 表格某单元格选中后，输入反馈直接发给 agent 定向迭代。
// 锚点（文件路径 + slide_index/cell）由 buildLocalityFeedbackMessage 编进消息文本，
// 走 useMessageActionStore.sendPrompt 解耦发送通道，主循环按文本自路由到 ppt_edit/excel_edit。
// 与 Phase 1 网页 LivePreviewFrame 的内联反馈框同一 UX。

import React, { useCallback, useState } from 'react';
import { Send } from 'lucide-react';
import { useMessageActionStore } from '../../stores/messageActionStore';
import {
  buildLocalityFeedbackMessage,
  type LocalityAnchor,
} from '../../../shared/livePreview/localityFeedback';

interface Props {
  anchor: LocalityAnchor;
  /** 选中位置的可读标签，如 "第 3 页" / "单元格 B7" */
  locationLabel: string;
}

export const LocalityFeedbackBar: React.FC<Props> = ({ anchor, locationLabel }) => {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const sendPrompt = useMessageActionStore((s) => s.sendPrompt);

  const submit = useCallback(async () => {
    const feedback = text.trim();
    if (!feedback || sending) return;
    setSending(true);
    try {
      // 文本给模型读，锚点给写前 guard 对账（ADR-040）。renderer 只报它诚实知道的
      // 坐标，revision 由 host 读源文件现算——这边送什么 revision 上去都不作数。
      await sendPrompt(buildLocalityFeedbackMessage(anchor, feedback), { localityAnchor: anchor });
      setText('');
    } finally {
      setSending(false);
    }
  }, [text, sending, sendPrompt, anchor]);

  return (
    <div className="flex items-center gap-2 rounded-lg border border-cyan-500/30 bg-cyan-500/[0.06] px-3 py-2">
      <span className="shrink-0 text-[11px] font-medium text-cyan-300">定点反馈 · {locationLabel}</span>
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          }
        }}
        placeholder="这里改成…（回车发送）"
        disabled={sending}
        className="flex-1 rounded border border-cyan-500/30 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 placeholder-zinc-500 focus:border-cyan-400 focus:outline-none disabled:opacity-60"
      />
      <button
        onClick={() => void submit()}
        disabled={sending || !text.trim()}
        className="flex items-center gap-1 rounded bg-cyan-500/30 px-2.5 py-1 text-xs text-cyan-100 hover:bg-cyan-500/40 disabled:cursor-not-allowed disabled:opacity-40"
        title="把反馈发给 agent，针对选中位置定向修改"
      >
        <Send className="h-3 w-3" />
        {sending ? '发送中' : '发送'}
      </button>
    </div>
  );
};

export default LocalityFeedbackBar;
