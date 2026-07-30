// ============================================================================
// DecisionCard —— 决策卡统一骨架（2026-07-29 拍板）
//
// 权限审批卡 / swarm 启动审批卡 / workflow 启动审批卡共用，DOM 与样式提炼自
// UserQuestionCard（AskUserQuestion 打断式选项卡）：同一只容器、同一套选项行、
// 同一条底部动作行，差别只在语义色与详情区内容。
//
// 语义色（与 UserQuestionCard 头部注释的约定一致）：
// - neutral = 中性蓝：常规审批 / 启动确认（「我需要你拍板」）
// - danger  = 红变体：危险操作（「我要动你的东西，而且有破坏力」），头部下方
//   多出一条警示行，替代旧 PermissionDialog 的 DangerWarning 嵌卡。
//
// 键盘（stopPropagation，与 UserQuestionCard 的 Esc 处理同族，防触发
// ChatView 的 Esc+Esc）：数字键 1-N 选中选项、Enter 确认（选中后才生效）、
// Esc 取消。输入框/文本域聚焦时不拦截。各卡自有的字母直发快捷键
// （权限卡 y/n/s/a）由适配层自己监听，不经本组件。
// ============================================================================

import React, { useEffect, useRef } from 'react';
import { AlertTriangle, Check } from 'lucide-react';
import { Button } from './primitives/Button';

export interface DecisionOption {
  /** 稳定 id，选中态与回调都以它为准 */
  id: string;
  label: string;
  description?: string;
  /** 直发快捷键提示（如 y / s / a / n），仅展示；按键行为由适配层实现 */
  shortcut?: string;
}

export interface DecisionCardProps {
  /** 语义色：中性蓝（默认）/ 危险红 */
  tone?: 'neutral' | 'danger';
  icon: React.ReactNode;
  title: string;
  /** 头部标题右侧的次要信息（如工具名） */
  headerMeta?: string;
  /** 危险警示行正文（tone=danger 时展示在头部下方） */
  dangerWarning?: string;
  /** 一行问题句（「允许写入 ~/work/report.md？」） */
  question: string;
  /** 结构化详情区（mono 路径/命令块、边界徽章、任务列表等），由各适配层提供 */
  details?: React.ReactNode;
  options: DecisionOption[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  confirmLabel: string;
  cancelLabel: string;
  /** 提交中：确认键禁用并转 loading */
  submitting?: boolean;
  /** 底部动作行上方的附加区（如反馈输入框、错误提示） */
  footerExtra?: React.ReactNode;
  /** 外层容器 className 覆盖（内联在消息流里的卡去掉 px-4 定位） */
  className?: string;
  testId?: string;
}

// 选中指示圆点：与 UserQuestionCard 的 SelectionIndicator 同形（单选，恒圆形）。
const SelectionIndicator: React.FC<{ selected: boolean }> = ({ selected }) => (
  <div
    className={`mt-0.5 w-4 h-4 rounded-full border-2 flex items-center justify-center ${
      selected ? 'border-blue-500 bg-blue-500' : 'border-zinc-600'
    }`}
  >
    {selected && <Check className="w-3 h-3 text-white" />}
  </div>
);

export const DecisionCard: React.FC<DecisionCardProps> = ({
  tone = 'neutral',
  icon,
  title,
  headerMeta,
  dangerWarning,
  question,
  details,
  options,
  selectedId,
  onSelect,
  onConfirm,
  onCancel,
  confirmLabel,
  cancelLabel,
  submitting = false,
  footerExtra,
  className = 'w-full px-4 animate-slideUp',
  testId = 'decision-card',
}) => {
  const cardRef = useRef<HTMLDivElement>(null);
  const danger = tone === 'danger';

  // 卡片出现时接管焦点（同 UserQuestionCard / 旧 PermissionCard 先例），键盘立即可用
  useEffect(() => {
    cardRef.current?.focus();
  }, []);

  // 数字键 1-N 选中、Enter 确认、Esc 取消；输入框聚焦时不拦截
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
        return;
      }
      if (e.key === 'Enter') {
        if (selectedId !== null && !submitting) {
          e.preventDefault();
          e.stopPropagation();
          onConfirm();
        }
        return;
      }
      const digit = Number.parseInt(e.key, 10);
      if (Number.isInteger(digit) && digit >= 1 && digit <= options.length && String(digit) === e.key) {
        e.preventDefault();
        e.stopPropagation();
        onSelect(options[digit - 1].id);
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [options, selectedId, submitting, onSelect, onConfirm, onCancel]);

  return (
    <div className={className} data-testid={testId}>
      <div
        ref={cardRef}
        tabIndex={-1}
        className={`w-full max-w-3xl mx-auto bg-zinc-900 rounded-lg shadow-2xl border-2 outline-hidden ${
          danger ? 'border-red-500' : 'border-blue-500/60'
        }`}
      >
        {/* 头部：与 UserQuestionCard 同形（图标 + 标题），语义色区分常规/危险 */}
        <div
          className={`flex items-center gap-2 px-4 py-2.5 border-b border-zinc-800 rounded-t-lg ${
            danger ? 'bg-red-500/10' : 'bg-blue-500/10'
          }`}
        >
          <span className={`shrink-0 ${danger ? 'text-red-400' : 'text-blue-400'}`}>{icon}</span>
          <span className={`text-sm font-medium ${danger ? 'text-red-300' : 'text-blue-300'}`}>
            {title}
          </span>
          {headerMeta && <span className="text-xs text-zinc-500 truncate">{headerMeta}</span>}
        </div>

        {/* 危险警示行：替代旧 DangerWarning 嵌卡，只占一行高度 */}
        {danger && dangerWarning && (
          <div className="flex items-center gap-2 px-4 py-2 border-b border-zinc-800 bg-red-500/5">
            <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
            <span className="text-xs text-red-300">{dangerWarning}</span>
          </div>
        )}

        {/* 体部：问题句 + 详情区 + 决策选项 */}
        <div className="space-y-3 max-h-[50vh] overflow-y-auto px-4 py-3">
          <p className="text-sm text-zinc-200">{question}</p>
          {details}
          <div className="space-y-2">
            {options.map((option) => (
              <button /* ds-allow:button: 选项行整面可点（选中指示+标题+描述复合内容），沿用 UserQuestionCard 选项行形态 */
                key={option.id}
                type="button"
                onClick={() => onSelect(option.id)}
                className={`w-full p-2.5 rounded-lg border text-left transition-all ${
                  selectedId === option.id
                    ? 'border-blue-500 bg-blue-500/10 ring-1 ring-blue-500/50'
                    : 'border-zinc-700 hover:border-zinc-600 hover:bg-zinc-800'
                }`}
              >
                <div className="flex items-start gap-3">
                  <SelectionIndicator selected={selectedId === option.id} />
                  <div className="flex-1">
                    <div className="font-medium text-zinc-200 text-sm">{option.label}</div>
                    {option.description && (
                      <p className="text-xs text-zinc-400 mt-0.5">{option.description}</p>
                    )}
                  </div>
                  {option.shortcut && (
                    <kbd className="mt-0.5 px-1 py-0.5 rounded bg-zinc-700 text-zinc-400 text-2xs font-mono shrink-0">
                      {option.shortcut}
                    </kbd>
                  )}
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* 底部：ghost 取消 + primary 确认（选中后才可点），与 UserQuestionCard 一致 */}
        <div className="px-4 pb-3">
          {footerExtra}
          <div className="mt-2.5 flex items-center justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={onCancel} disabled={submitting}>
              {cancelLabel}
            </Button>
            <Button
              size="sm"
              onClick={onConfirm}
              disabled={selectedId === null || submitting}
              loading={submitting}
            >
              {confirmLabel}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default DecisionCard;
