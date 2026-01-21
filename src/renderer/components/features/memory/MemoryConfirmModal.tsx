// ============================================================================
// MemoryConfirmModal - Phase 3 低置信度记忆确认弹窗
// 当 AI 学到低置信度的记忆时，询问用户是否确认保存
// ============================================================================

import React from 'react';
import { Brain, X, Check, AlertTriangle } from 'lucide-react';
import { Button } from '../../primitives';
import type { PendingMemoryConfirm } from '../../../hooks/useMemoryLearning';
import { getCategoryLabel, getTypeLabel } from '../../../hooks/useMemoryLearning';

interface MemoryConfirmModalProps {
  request: PendingMemoryConfirm;
  onConfirm: () => void;
  onDecline: () => void;
}

/**
 * Memory 确认弹窗
 * 显示低置信度记忆内容，询问用户是否确认保存
 */
export const MemoryConfirmModal: React.FC<MemoryConfirmModalProps> = ({
  request,
  onConfirm,
  onDecline,
}) => {
  const confidencePercent = Math.round(request.confidence * 100);

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center">
      {/* 背景遮罩 */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onDecline}
      />

      {/* 弹窗内容 */}
      <div className="relative bg-zinc-900 rounded-lg border border-zinc-800 shadow-2xl max-w-md w-full mx-4 overflow-hidden">
        {/* 头部 */}
        <div className="flex items-center gap-3 px-4 py-3 bg-zinc-800/50 border-b border-zinc-800">
          <div className="w-8 h-8 rounded-full bg-amber-500/20 flex items-center justify-center">
            <Brain className="w-4 h-4 text-amber-400" />
          </div>
          <div className="flex-1">
            <h3 className="text-sm font-medium text-zinc-100">确认记忆</h3>
            <p className="text-xs text-zinc-400">AI 想要记住以下内容</p>
          </div>
          <button
            onClick={onDecline}
            className="p-1.5 hover:bg-zinc-700 rounded-lg transition-colors"
          >
            <X className="w-4 h-4 text-zinc-400" />
          </button>
        </div>

        {/* 内容区域 */}
        <div className="p-4 space-y-4">
          {/* 置信度警告 */}
          <div className="flex items-start gap-2 p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg">
            <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 flex-shrink-0" />
            <div className="text-xs text-amber-300">
              这是一个推测性的学习（置信度 {confidencePercent}%），需要您的确认。
            </div>
          </div>

          {/* 记忆内容 */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-xs text-zinc-500">分类:</span>
              <span className="text-xs px-2 py-0.5 bg-zinc-800 rounded text-zinc-300">
                {getCategoryLabel(request.category)}
              </span>
              <span className="text-xs text-zinc-500">类型:</span>
              <span className="text-xs px-2 py-0.5 bg-zinc-800 rounded text-zinc-300">
                {getTypeLabel(request.type)}
              </span>
            </div>

            <div className="p-3 bg-zinc-800/50 rounded-lg border border-zinc-700">
              <p className="text-sm text-zinc-200 whitespace-pre-wrap break-words">
                {request.content}
              </p>
            </div>
          </div>

          {/* 提示 */}
          <p className="text-xs text-zinc-500">
            确认后，此信息将被保存并用于改进未来的助理体验。
          </p>
        </div>

        {/* 底部按钮 */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 bg-zinc-800/30 border-t border-zinc-800">
          <Button
            variant="secondary"
            size="sm"
            onClick={onDecline}
          >
            <X className="w-4 h-4 mr-1" />
            跳过
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={onConfirm}
          >
            <Check className="w-4 h-4 mr-1" />
            确认保存
          </Button>
        </div>
      </div>
    </div>
  );
};
