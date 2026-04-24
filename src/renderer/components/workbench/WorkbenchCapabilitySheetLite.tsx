import React from 'react';
import { AlertTriangle, CheckCircle2, Loader2, Plug, Sparkles, Wrench } from 'lucide-react';
import type { BlockedCapabilityReason } from '@shared/contract/turnTimeline';
import type { WorkbenchHistoryItem } from '../../hooks/useWorkbenchCapabilities';
import { Modal } from '../primitives/Modal';
import { WorkbenchPill, type WorkbenchPillTone } from './WorkbenchPrimitives';
import {
  formatWorkbenchHistoryActionSummary,
  getWorkbenchCapabilityStatusPresentation,
} from '../../utils/workbenchPresentation';
import {
  getWorkbenchCapabilityBlockedState,
  type WorkbenchCapabilityRegistryItem,
} from '../../utils/workbenchCapabilityRegistry';
import {
  getWorkbenchCapabilityQuickActions,
  getWorkbenchCapabilityQuickActionFeedback,
  type WorkbenchQuickAction,
} from '../../utils/workbenchQuickActions';

interface WorkbenchCapabilitySheetLiteProps {
  isOpen: boolean;
  capability: WorkbenchCapabilityRegistryItem | null;
  historyItem?: WorkbenchHistoryItem | null;
  blockedReason?: BlockedCapabilityReason | null;
  runningActionKey: string | null;
  actionError?: string | null;
  completedAction?: { kind: WorkbenchQuickAction['kind']; completedAt: number } | null;
  onQuickAction: (
    capability: WorkbenchCapabilityRegistryItem,
    action: WorkbenchQuickAction,
  ) => Promise<void>;
  onClose: () => void;
}

function getCapabilityTone(capability: WorkbenchCapabilityRegistryItem): WorkbenchPillTone {
  switch (capability.kind) {
    case 'skill':
      return 'skill';
    case 'connector':
      return 'connector';
    case 'mcp':
      return 'mcp';
    default:
      return 'neutral';
  }
}

function getCapabilityKindLabel(capability: WorkbenchCapabilityRegistryItem): string {
  switch (capability.kind) {
    case 'skill':
      return 'Skill';
    case 'connector':
      return 'Connector';
    case 'mcp':
      return 'MCP';
    default:
      return 'Capability';
  }
}

function getCapabilityIcon(capability: WorkbenchCapabilityRegistryItem): React.ReactNode {
  switch (capability.kind) {
    case 'skill':
      return <Sparkles className="h-4 w-4 text-fuchsia-300" />;
    case 'connector':
      return <Plug className="h-4 w-4 text-sky-300" />;
    case 'mcp':
      return <Plug className="h-4 w-4 text-emerald-300" />;
    default:
      return <Wrench className="h-4 w-4 text-zinc-300" />;
  }
}

function formatLifecycleValue(value: string): string {
  switch (value) {
    case 'installed':
      return '已安装';
    case 'missing':
      return '缺失';
    case 'mounted':
      return '已挂载';
    case 'unmounted':
      return '未挂载';
    case 'connected':
      return '已连接';
    case 'connecting':
      return '连接中';
    case 'disconnected':
      return '未连接';
    case 'error':
      return '错误';
    case 'lazy':
      return '懒加载';
    default:
      return value;
  }
}

function getLifecycleRows(capability: WorkbenchCapabilityRegistryItem): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];

  if (capability.lifecycle.installState !== 'not_applicable') {
    rows.push({
      label: '安装',
      value: formatLifecycleValue(capability.lifecycle.installState),
    });
  }

  if (capability.lifecycle.mountState !== 'not_applicable') {
    rows.push({
      label: '挂载',
      value: formatLifecycleValue(capability.lifecycle.mountState),
    });
  }

  if (capability.lifecycle.connectionState !== 'not_applicable') {
    rows.push({
      label: '连接',
      value: capability.kind === 'connector' && capability.lifecycle.connectionState === 'lazy'
        ? '待检查'
        : formatLifecycleValue(capability.lifecycle.connectionState),
    });
  }

  return rows;
}

function renderCapabilityMeta(capability: WorkbenchCapabilityRegistryItem): React.ReactNode {
  if (capability.kind === 'skill') {
    return (
      <div className="space-y-1 text-[11px] text-zinc-400">
        {capability.description && (
          <div className="leading-relaxed text-zinc-300">{capability.description}</div>
        )}
        {capability.source && <div>来源: {capability.source}</div>}
        {capability.libraryId && <div>Library: {capability.libraryId}</div>}
      </div>
    );
  }

  if (capability.kind === 'connector') {
    return (
      <div className="space-y-1 text-[11px] text-zinc-400">
        {capability.detail && (
          <div className="leading-relaxed text-zinc-300">{capability.detail}</div>
        )}
        {capability.capabilities.length > 0 && (
          <div>能力: {capability.capabilities.slice(0, 4).join(' · ')}</div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-1 text-[11px] text-zinc-400">
      <div>transport: {capability.transport}</div>
      <div>tools: {capability.toolCount} · resources: {capability.resourceCount}</div>
      <div>{capability.enabled ? '当前已启用' : '当前已禁用'}</div>
      {capability.error && (
        <div className="leading-relaxed text-zinc-300">{capability.error}</div>
      )}
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
      <div className="mb-2 text-[10px] uppercase tracking-[0.18em] text-zinc-500">{title}</div>
      {children}
    </section>
  );
}

export const WorkbenchCapabilitySheetLite: React.FC<WorkbenchCapabilitySheetLiteProps> = ({
  isOpen,
  capability,
  historyItem,
  blockedReason,
  runningActionKey,
  actionError,
  completedAction,
  onQuickAction,
  onClose,
}) => {
  if (!capability) {
    return null;
  }

  const status = getWorkbenchCapabilityStatusPresentation(capability, { locale: 'zh' });
  const lifecycleRows = getLifecycleRows(capability);
  const quickActions = getWorkbenchCapabilityQuickActions(capability, { includeUnselected: true });
  const feedback = getWorkbenchCapabilityQuickActionFeedback(capability, completedAction);
  const actionSummary = historyItem ? formatWorkbenchHistoryActionSummary(historyItem.topActions, { maxActions: 3 }) : null;
  const effectiveBlockedReason = blockedReason || getWorkbenchCapabilityBlockedState(capability) || null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={capability.label}
      size="lg"
      className="ml-auto mr-0 h-full max-h-full rounded-none rounded-l-2xl border-r-0"
      headerIcon={getCapabilityIcon(capability)}
    >
      <div className="space-y-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <WorkbenchPill tone={getCapabilityTone(capability)}>
            {getCapabilityKindLabel(capability)}
          </WorkbenchPill>
          <span className={`text-sm ${status.colorClass}`}>{status.label}</span>
          {capability.selected && (
            <WorkbenchPill tone="info">当前消息已选</WorkbenchPill>
          )}
        </div>

        <Section title="概览">
          {renderCapabilityMeta(capability)}
        </Section>

        <Section title="当前状态">
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm text-zinc-200">
              <CheckCircle2 className={`h-4 w-4 ${status.colorClass}`} />
              <span>{status.label}</span>
            </div>
            {lifecycleRows.length > 0 && (
              <div className="space-y-1 text-[11px] text-zinc-400">
                {lifecycleRows.map((row) => (
                  <div key={row.label} className="flex items-center justify-between gap-3">
                    <span>{row.label}</span>
                    <span className="text-zinc-300">{row.value}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Section>

        {effectiveBlockedReason && (
          <Section title={blockedReason ? '本轮阻塞原因' : '阻塞原因'}>
            <div className="flex items-start gap-2 text-[11px] text-zinc-300">
              <AlertTriangle
                className={`mt-0.5 h-3.5 w-3.5 flex-shrink-0 ${
                  effectiveBlockedReason.severity === 'error' ? 'text-red-300' : 'text-amber-300'
                }`}
              />
              <div className="space-y-1">
                <div className="text-zinc-200">{effectiveBlockedReason.detail}</div>
                {effectiveBlockedReason.hint && (
                  <div className="text-zinc-500">{effectiveBlockedReason.hint}</div>
                )}
              </div>
            </div>
          </Section>
        )}

        {(quickActions.length > 0 || actionError || feedback) && (
          <Section title="快速动作">
            <div className="space-y-2">
              {quickActions.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {quickActions.map((action) => {
                    const actionKey = `${capability.key}:${action.kind}`;
                    const loading = runningActionKey === actionKey;
                    return (
                      <button
                        key={action.kind}
                        type="button"
                        onClick={() => void onQuickAction(capability, action)}
                        disabled={loading}
                        className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                          action.emphasis === 'primary'
                            ? 'border-amber-500/30 bg-amber-500/10 text-amber-200 hover:border-amber-500/50 hover:bg-amber-500/15'
                            : 'border-white/[0.08] bg-zinc-900/60 text-zinc-300 hover:border-white/[0.14] hover:text-zinc-100'
                        }`}
                      >
                        {loading && <Loader2 className="h-3 w-3 animate-spin" />}
                        <span>{action.label}</span>
                      </button>
                    );
                  })}
                </div>
              )}
              {actionError && (
                <div className="text-[11px] text-red-300">{actionError}</div>
              )}
              {feedback && !actionError && (
                <div className={`text-[11px] ${feedback.tone === 'success' ? 'text-emerald-300' : 'text-sky-300'}`}>
                  {feedback.message}
                </div>
              )}
            </div>
          </Section>
        )}

        <Section title="最近使用">
          {historyItem ? (
            <div className="space-y-1 text-[11px] text-zinc-400">
              <div>本会话调用 {historyItem.count} 次</div>
              {actionSummary ? (
                <div className="text-zinc-300">最近动作: {actionSummary}</div>
              ) : (
                <div className="text-zinc-500">最近没有额外 action summary。</div>
              )}
            </div>
          ) : (
            <div className="text-[11px] text-zinc-500">本会话还没有这项能力的调用记录。</div>
          )}
        </Section>
      </div>
    </Modal>
  );
};

export default WorkbenchCapabilitySheetLite;
