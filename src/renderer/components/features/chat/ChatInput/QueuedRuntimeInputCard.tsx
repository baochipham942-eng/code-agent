// ============================================================================
// 排队（引导）消息卡 —— 输入框上方的独立悬浮卡片
// ============================================================================
//
// 此前排队项渲染在输入框容器内部（textarea 与底部工具栏之间），等于把「引导条」和
// 「输入框」硬塞进同一个框：气泡把输入区撑高，多条排队一条一个气泡能占掉半屏。
//
// 现在它是输入框的兄弟节点、自己的容器：
//   · 左侧只放计数，不铺正文（正文展开后才逐条显示，且单行截断）
//   · 右侧动作收成图标组
//   · 多条默认折叠，撑不高输入区
// ============================================================================

import React, { useState } from 'react';
import { ChevronDown, ChevronUp, Clock3, CornerDownRight, SendHorizontal, X } from 'lucide-react';
import { useI18n } from '../../../../hooks/useI18n';

export interface QueuedRuntimeInputCardItem {
  id: string;
  content: string;
  attachmentsCount: number;
}

interface QueuedRuntimeInputCardProps {
  items: QueuedRuntimeInputCardItem[];
  /** 会话运行中：这轮还没结束，排队项只能等，不给「立即发送」 */
  isProcessing: boolean;
  onSend?: (id: string) => void;
  onCancel?: (id: string) => void;
}

export const QueuedRuntimeInputCard: React.FC<QueuedRuntimeInputCardProps> = ({
  items,
  isProcessing,
  onSend,
  onCancel,
}) => {
  const { t } = useI18n();
  // 单条默认展开（就一行，藏起来反而多一次点击）；多条默认折叠，避免堆满半屏。
  const [expanded, setExpanded] = useState(false);
  const isExpanded = items.length === 1 || expanded;

  if (items.length === 0) return null;

  return (
    <div
      data-testid="queued-runtime-input-card"
      className="mb-1.5 rounded-2xl border border-white/[0.06] bg-zinc-900/70 backdrop-blur-sm px-3 py-2"
    >
      <div className="flex items-center gap-2 text-[11px] text-zinc-400">
        <CornerDownRight className="h-3.5 w-3.5 shrink-0" />
        <span data-testid="queued-runtime-input-count">
          {t.chatInput.queuedCardCount.replace('{count}', String(items.length))}
        </span>
        {isProcessing && (
          <span className="inline-flex items-center gap-1 text-zinc-500">
            <Clock3 className="h-3 w-3" />
            {t.chatInput.queuedWaiting}
          </span>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          {items.length > 1 && (
            <button
              type="button"
              data-testid="queued-runtime-input-toggle"
              onClick={() => setExpanded((current) => !current)}
              title={isExpanded ? t.chatInput.queuedCollapseTitle : t.chatInput.queuedExpandTitle}
              className="inline-flex h-6 w-6 items-center justify-center rounded text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200"
            >
              {isExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </button>
          )}
        </div>
      </div>

      {isExpanded && (
        <ul className="mt-1.5 space-y-1">
          {items.map((item) => (
            <li key={item.id} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[13px] text-zinc-200">
                {item.content}
              </span>
              {item.attachmentsCount > 0 && (
                <span className="shrink-0 text-[11px] text-zinc-500">
                  {t.chatInput.queuedAttachments.replace('{count}', String(item.attachmentsCount))}
                </span>
              )}
              {!isProcessing && (
                <button
                  type="button"
                  data-testid={`queued-runtime-input-send-${item.id}`}
                  onClick={() => onSend?.(item.id)}
                  title={t.chatInput.queuedSendNowTitle}
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200"
                >
                  <SendHorizontal className="h-3.5 w-3.5" />
                </button>
              )}
              <button
                type="button"
                data-testid={`queued-runtime-input-withdraw-${item.id}`}
                onClick={() => onCancel?.(item.id)}
                title={t.chatInput.queuedWithdrawTitle}
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
