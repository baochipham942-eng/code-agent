// ============================================================================
// DecisionCard —— 决策卡统一骨架（2026-07-29 拍板）
//
// 权限审批卡 / swarm 启动审批卡 / workflow 启动审批卡共用，DOM 与样式提炼自
// UserQuestionCard（AskUserQuestion 打断式选项卡）：同一只容器、同一套选项行、
// 同一条底部动作行，差别只在语义色与详情区内容。
//
// 语义色（与 UserQuestionCard 头部注释的约定一致）：
// - neutral = 中性蓝：提问 / 计划 / 启动确认（「我需要你拍板」）
// - amber  = 权限琥珀：常规授权（「我要动你的东西」）
// - danger  = 红变体：危险操作（「我要动你的东西，而且有破坏力」），头部下方
//   多出一条警示行，替代旧 PermissionDialog 的 DangerWarning 嵌卡。
//
// 键盘（stopPropagation，与 UserQuestionCard 的 Esc 处理同族，防触发
// ChatView 的 Esc+Esc）：数字键 1-N 选中选项、Enter 执行当前聚焦的主按钮、
// Esc 收起。输入框/文本域聚焦时不拦截数字键与 Enter。各卡自有的字母直发快捷键
// （权限卡 y/n/s/a）由适配层自己监听，不经本组件。
// ============================================================================

import React, { useEffect, useRef } from 'react';
import { Check } from 'lucide-react';
import { Button } from './primitives/Button';

export interface DecisionOption {
  /** 稳定 id，选中态与回调都以它为准 */
  id: string;
  label: string;
  description?: string;
  /** 直发快捷键提示（如 y / s / a / n），仅展示；按键行为由适配层实现 */
  shortcut?: string;
  disabled?: boolean;
}

export type DecisionCardViewMode = 'compact' | 'expanded';

export interface DecisionCardProps {
  /** 语义色：中性蓝（默认）/ 常规权限琥珀 / 危险红 */
  tone?: 'neutral' | 'amber' | 'danger';
  icon: React.ReactNode;
  title: string;
  /** 头部标题右侧的次要信息（如工具名） */
  headerMeta?: string;
  /** 头部右侧终态徽标等；未传时其他消费方 DOM 不变。 */
  headerEnd?: React.ReactNode;
  /** 一行问题句（「允许写入 ~/work/report.md？」） */
  question: string;
  /** 结构化详情区（mono 路径/命令块、边界徽章、任务列表等），由各适配层提供 */
  details?: React.ReactNode;
  options: DecisionOption[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onConfirm: () => void;
  /** Esc 只收起卡片，不代表任何裁决。 */
  onCollapse?: () => void;
  /** 危险或不可撤回操作不允许 Enter 确认，仍可鼠标点击或字母键直发。 */
  enterDisabled?: boolean;
  /** 底部 ghost 动作，仅由鼠标点击，不再与 Esc 绑定。 */
  onCancel?: () => void;
  confirmLabel: string;
  cancelLabel?: string;
  /** 提交中：确认键禁用并转 loading */
  submitting?: boolean;
  /** 底部动作行上方的附加区（如反馈输入框、错误提示） */
  footerExtra?: React.ReactNode;
  /** 历史终态卡不再展示确认动作。 */
  hideFooter?: boolean;
  /** 已裁决卡退为中性灰，避免继续呈现为等待输入。 */
  settled?: boolean;
  /** 槽位展开态：详情可滚动，选项与确认区固定在卡底。 */
  pinActions?: boolean;
  /** 业务卡决定默认态与切换结果；骨架不推断请求风险。 */
  viewMode?: DecisionCardViewMode;
  onViewModeChange?: (mode: DecisionCardViewMode) => void;
  expandLabel?: string;
  collapseLabel?: string;
  /** 选项改为点即裁决按钮，不再先选单选项再二次确认。 */
  directActions?: boolean;
  onDirectAction?: (id: string) => void;
  /** 直裁决模式下的蓝色主按钮；危险卡传 deny。 */
  primaryActionId?: string;
  /** 直裁决模式下的红色描边按钮；危险卡传 once。 */
  dangerActionId?: string;
  /** 外层容器 className 覆盖（内联在消息流里的卡去掉 px-4 定位） */
  className?: string;
  testId?: string;
}

// 可编辑目标判定：input/textarea + contentEditable（neo composer 是
// contentEditable，先例见 useKeyboardShortcuts 的 isInputTarget）。
// PermissionCard 的字母直发快捷键也复用这份判定。
export function isEditableTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return Boolean(
    element instanceof HTMLInputElement
    || element instanceof HTMLTextAreaElement
    || element?.isContentEditable
  );
}

// 选中指示圆点：与 UserQuestionCard 的 SelectionIndicator 同形（单选，恒圆形）。
const SelectionIndicator: React.FC<{ selected: boolean }> = ({ selected }) => (
  <div
    className={`mt-0.5 w-4 h-4 rounded-full border-2 flex items-center justify-center ${
      selected ? 'border-badge-info bg-blue-500' : 'border-zinc-600'
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
  headerEnd,
  question,
  details,
  options,
  selectedId,
  onSelect,
  onConfirm,
  onCollapse,
  enterDisabled = false,
  onCancel,
  confirmLabel,
  cancelLabel,
  submitting = false,
  footerExtra,
  hideFooter = false,
  settled = false,
  pinActions = false,
  viewMode = 'expanded',
  onViewModeChange,
  expandLabel = 'Details',
  collapseLabel = 'Collapse',
  directActions = false,
  onDirectAction,
  primaryActionId,
  dangerActionId,
  className = 'w-full px-4 animate-slideUp',
  testId = 'decision-card',
}) => {
  const cardRef = useRef<HTMLDivElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const directPrimaryRef = useRef<HTMLButtonElement>(null);
  const danger = tone === 'danger';
  const amber = tone === 'amber';
  const compact = viewMode === 'compact';

  // 选中主选项后默认高亮主按钮；危险/写回卡也保留焦点证据，Enter 由 enterDisabled 硬挡。
  useEffect(() => {
    if (directActions && !submitting) {
      directPrimaryRef.current?.focus();
    } else if (selectedId !== null && !submitting) {
      confirmButtonRef.current?.focus();
    } else {
      cardRef.current?.focus();
    }
  }, [directActions, primaryActionId, selectedId, submitting, viewMode]);

  // 数字键 1-N 选中、Enter 执行当前聚焦的主按钮、Esc 收起。
  // 守卫：
  // - 可编辑目标内不拦截数键与 Enter，Esc 仍保持全族收起语义；
  // - submitting 期间 Esc/Enter 只吞不动作，防确认在途时双发 IPC。
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const editable = isEditableTarget(e.target);
      if (e.key === 'Escape') {
        if (submitting || onCollapse) {
          e.preventDefault();
          e.stopPropagation();
        }
        if (!submitting) onCollapse?.();
        return;
      }
      if (editable) return;
      if (e.key === 'Enter') {
        if (directActions && directPrimaryRef.current === document.activeElement) {
          e.preventDefault();
          e.stopPropagation();
          if (!submitting && !enterDisabled && primaryActionId) onDirectAction?.(primaryActionId);
          return;
        }
        if (confirmButtonRef.current === document.activeElement && selectedId !== null) {
          e.preventDefault();
          e.stopPropagation();
          if (!submitting && !enterDisabled) onConfirm();
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
  }, [options, selectedId, submitting, onSelect, onConfirm, onCollapse, enterDisabled, directActions, onDirectAction, primaryActionId]);

  const optionRows = options.map((option) => (
    <button /* ds-allow:button: 选项行整面可点（选中指示+标题+描述复合内容），沿用 UserQuestionCard 选项行形态 */
      key={option.id}
      type="button"
      onClick={() => onSelect(option.id)}
      disabled={option.disabled}
      className={`w-full p-2.5 rounded-lg border text-left transition-all ${
        selectedId === option.id
          ? 'border-badge-info bg-blue-500/10 ring-1 ring-blue-500/50'
          : 'border-zinc-700 hover:border-zinc-600 hover:bg-zinc-800'
      } ${option.disabled ? 'cursor-not-allowed opacity-45 hover:border-zinc-700 hover:bg-transparent' : ''}`}
    >
      <div className="flex items-start gap-3">
        <SelectionIndicator selected={selectedId === option.id} />
        <div className="flex-1">
          <div className="font-medium text-zinc-200 text-sm">{option.label}</div>
          {option.description && (
            <p className="text-xs text-zinc-400 mt-0.5">{option.description}</p>
          )}
        </div>
        {option.shortcut && !option.disabled && (
          <kbd className="mt-0.5 px-1 py-0.5 rounded bg-zinc-700 text-zinc-400 text-2xs font-mono shrink-0">
            {option.shortcut}
          </kbd>
        )}
      </div>
    </button>
  ));

  const actionButtons = options.map((option) => {
    const primary = option.id === primaryActionId;
    const dangerAction = option.id === dangerActionId;
    return (
      <Button
        ref={primary ? directPrimaryRef : undefined}
        key={option.id}
        size="sm"
        variant={primary ? 'primary' : 'ghost'}
        className={`h-7 shrink-0 rounded-md py-1 ${
          dangerAction ? 'border border-red-500/50 text-badge-danger hover:bg-red-500/10 hover:text-badge-danger' : ''
        } ${primary && dangerActionId ? 'ml-auto' : ''}`}
        disabled={option.disabled || submitting}
        loading={submitting && primary}
        onClick={() => onDirectAction?.(option.id)}
      >
        <span className="inline-flex items-center gap-1.5">
          {option.label}
          {option.shortcut && (
            <kbd className="rounded bg-zinc-700 px-1 py-px font-mono text-[9px] text-zinc-400">
              {option.shortcut}
            </kbd>
          )}
        </span>
      </Button>
    );
  });

  return (
    <div className={className} data-testid={testId}>
      <div
        ref={cardRef}
        tabIndex={-1}
        className={`w-full max-w-3xl mx-auto bg-zinc-900 rounded-lg shadow-md dark:shadow-2xl border-4 outline-hidden ${
          settled ? 'border-zinc-700' : danger ? 'border-red-500' : amber ? 'border-badge-warning/60' : 'border-badge-info/60'
        } ${compact ? 'overflow-hidden' : pinActions ? 'flex max-h-[40vh] flex-col overflow-hidden' : ''}`}
        data-view-mode={viewMode}
      >
        {compact ? (
          <div className="flex h-10 items-center gap-2 px-3" data-testid={`${testId}-compact-row`}>
            <span className={`shrink-0 ${danger ? 'text-badge-danger' : amber ? 'text-badge-warning' : 'text-badge-info'}`}>
              {icon}
            </span>
            <span className="min-w-0 flex-1 truncate text-xs text-zinc-200">{question}</span>
            {directActions && actionButtons}
            {onViewModeChange && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 shrink-0 rounded-md py-1"
                onClick={() => onViewModeChange('expanded')}
              >
                {expandLabel}
              </Button>
            )}
          </div>
        ) : (
          <>
        {/* 头部：与 UserQuestionCard 同形（图标 + 标题），语义色区分常规/危险 */}
        <div
          className={`flex items-center gap-2 px-3.5 py-2 border-b border-zinc-800 rounded-t-lg ${
            settled ? 'bg-zinc-800' : danger ? 'bg-red-500/10' : amber ? 'bg-amber-500/10' : 'bg-blue-500/10'
          }`}
        >
          <span className={`shrink-0 ${settled ? 'text-zinc-400' : danger ? 'text-badge-danger' : amber ? 'text-badge-warning' : 'text-badge-info'}`}>{icon}</span>
          <span className={`text-xs font-semibold ${settled ? 'text-zinc-300' : danger ? 'text-badge-danger' : amber ? 'text-badge-warning' : 'text-badge-info'}`}>
            {title}
          </span>
          {headerMeta && <span className="text-xs text-zinc-500 truncate">{headerMeta}</span>}
          {headerEnd && <span className="ml-auto shrink-0">{headerEnd}</span>}
          {onViewModeChange && (
            <Button
              size="sm"
              variant="ghost"
              className={`${headerEnd ? '' : 'ml-auto'} h-6 shrink-0 rounded-md px-2 py-0.5 text-[11px]`}
              onClick={() => onViewModeChange('compact')}
            >
              {collapseLabel}
            </Button>
          )}
        </div>

        {/* 槽位卡只让详情区滚动；选项与确认区留在可见卡底。其他消费方保持原骨架。 */}
        {pinActions ? (
          <>
            <div
              className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3"
              data-testid={`${testId}-details-scroll`}
            >
              <p className="text-[13px] font-semibold leading-[1.5] text-zinc-100">{question}</p>
              {details}
            </div>
            {options.length > 0 && (
              <div className="shrink-0 space-y-2 px-4" data-testid={`${testId}-pinned-options`}>
                {directActions ? (
                  <div className={`flex flex-wrap items-center gap-2 border-t border-zinc-800 py-2 ${dangerActionId ? '' : 'justify-end'}`}>
                    {actionButtons}
                  </div>
                ) : optionRows}
              </div>
            )}
          </>
        ) : (
          <div className="space-y-3 max-h-[50vh] overflow-y-auto px-4 py-3">
            <p className="text-[13px] font-semibold leading-[1.5] text-zinc-100">{question}</p>
            {details}
            <div className="space-y-2">
              {directActions ? actionButtons : optionRows}
            </div>
          </div>
        )}

        {/* 底部：ghost 取消 + primary 确认（选中后才可点），与 UserQuestionCard 一致 */}
        {!hideFooter && !directActions && <div className={`px-4 pb-3 ${pinActions ? 'shrink-0' : ''}`} data-testid={`${testId}-actions`}>
          {footerExtra}
          <div className="mt-2.5 flex items-center justify-end gap-2">
            {onCancel && cancelLabel && (
              <Button size="sm" variant="ghost" onClick={onCancel} disabled={submitting}>
                {cancelLabel}
              </Button>
            )}
            <Button
              ref={confirmButtonRef}
              size="sm"
              onClick={onConfirm}
              disabled={selectedId === null || submitting}
              loading={submitting}
            >
              {confirmLabel}
            </Button>
          </div>
        </div>}
          </>
        )}
      </div>
    </div>
  );
};

export const DecisionCollapsedBar: React.FC<{
  label: string;
  expandLabel: string;
  count: number;
  onExpand: () => void;
  className?: string;
  testId?: string;
}> = ({ label, expandLabel, count, onExpand, className = 'w-full', testId = 'decision-collapsed-bar' }) => {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onExpand();
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [onExpand]);

  return (
    <div className={`flex justify-end ${className}`} data-testid={`${testId}-container`}>
      <button /* ds-allow:button: 收起后的决策状态整颗可点，固定 28px 胶囊不适用常规 Button 尺寸。 */
        type="button"
        onClick={onExpand}
        className="inline-flex h-7 items-center gap-1.5 rounded-full border border-badge-info/40 bg-zinc-900 px-3 text-xs text-badge-info shadow-sm hover:bg-zinc-800 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
        data-testid={testId}
        aria-label={`${label} (${count}) · ${expandLabel}`}
      >
        <span aria-hidden="true">●</span>
        <span>{label} ({count})</span>
        <span aria-hidden="true">·</span>
        <span>{expandLabel}</span>
      </button>
    </div>
  );
};

export default DecisionCard;
