import React, { useCallback, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Circle,
  Eye,
  FileText,
  FolderGit2,
  GitBranch,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc';
import type {
  AgentTreeChangedFile,
  AgentTreeNode,
  AgentTreeNodeStatus,
  AgentTreeSnapshot,
  AgentWorktreeReview,
} from '@shared/contract/agentTree';
import ipcService from '../../../services/ipcService';
import { useSessionStore } from '../../../stores/sessionStore';
import { useAgentTreeSnapshot } from '../../../hooks/useAgentTreeSnapshot';

interface AgentTreeSnapshotViewProps {
  snapshot: AgentTreeSnapshot;
  worktreeReviews?: Record<string, AgentWorktreeReview | undefined>;
  loadingReviewIds?: Set<string>;
  onReviewWorktree?: (agentId: string) => void;
}

const STATUS_STYLE: Record<AgentTreeNodeStatus, { icon: React.ReactNode; className: string }> = {
  queued: { icon: <Circle className="h-3.5 w-3.5" />, className: 'text-zinc-500' },
  running: { icon: <Loader2 className="h-3.5 w-3.5 animate-spin" />, className: 'text-sky-300' },
  'running-recovered': { icon: <Loader2 className="h-3.5 w-3.5 animate-spin" />, className: 'text-sky-300' },
  'dead-log-only': { icon: <FileText className="h-3.5 w-3.5" />, className: 'text-zinc-500' },
  completed: { icon: <CheckCircle2 className="h-3.5 w-3.5" />, className: 'text-emerald-300' },
  failed: { icon: <AlertCircle className="h-3.5 w-3.5" />, className: 'text-rose-300' },
  cancelled: { icon: <Circle className="h-3.5 w-3.5" />, className: 'text-zinc-500' },
  killed: { icon: <AlertCircle className="h-3.5 w-3.5" />, className: 'text-rose-300' },
  blocked: { icon: <AlertCircle className="h-3.5 w-3.5" />, className: 'text-amber-300' },
  unknown: { icon: <Circle className="h-3.5 w-3.5" />, className: 'text-zinc-500' },
};

function cleanText(value?: string): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  return text
    .replace(/\btypecheck\b/gi, '类型检查')
    .replace(/\bexitCode\b/g, '退出状态')
    .replace(/\bstderr\b/gi, '错误输出')
    .replace(/\bstdout\b/gi, '运行输出');
}

export function formatAgentToolName(tool?: string): string | undefined {
  const value = tool?.trim();
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  if (normalized.includes('bash') || normalized.includes('shell')) return '命令行';
  if (normalized.includes('read')) return '读取文件';
  if (normalized.includes('edit') || normalized.includes('write')) return '修改文件';
  if (normalized.includes('grep') || normalized.includes('search') || normalized.includes('rg')) return '搜索资料';
  if (normalized.includes('browser')) return '浏览器';
  if (normalized.includes('computer')) return '桌面操作';
  if (normalized.includes('test')) return '验证';
  return cleanText(value);
}

function changedFileStatusLabel(status: AgentTreeChangedFile['status']): string {
  switch (status) {
    case 'added':
      return '新增';
    case 'modified':
      return '已修改';
    case 'deleted':
      return '已删除';
    case 'renamed':
      return '已改名';
    case 'copied':
      return '已复制';
    case 'untracked':
      return '新文件';
    case 'unknown':
    default:
      return '有变化';
  }
}

function formatMoney(value?: number): string | null {
  if (typeof value !== 'number') return null;
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

function NodeLine({
  node,
  depth,
  worktreeReviews,
  loadingReviewIds,
  onReviewWorktree,
}: {
  node: AgentTreeNode;
  depth: number;
  worktreeReviews?: Record<string, AgentWorktreeReview | undefined>;
  loadingReviewIds?: Set<string>;
  onReviewWorktree?: (agentId: string) => void;
}) {
  const style = STATUS_STYLE[node.status] ?? STATUS_STYLE.unknown;
  const activeTool = formatAgentToolName(node.activeTool);
  const progress = cleanText(node.progress ?? node.lastEvent?.summary);
  const failureReason = cleanText(node.failureReason);
  const worktree = node.worktreeState;
  const review = worktreeReviews?.[node.id];
  const changedFiles = review?.changedFiles ?? worktree.changedFiles ?? [];
  const diffSummary = cleanText(review?.diffSummary ?? worktree.diffSummary);
  const diff = cleanText(review?.diff);
  const isReviewLoading = loadingReviewIds?.has(node.id) ?? false;
  const hasWorktree = worktree.status !== 'none';
  const canReview = hasWorktree && worktree.status !== 'cleaned' && Boolean(onReviewWorktree);
  const cost = formatMoney(node.budgetSummary.costUsd);

  return (
    <div className={depth === 0 ? 'space-y-1' : 'space-y-1 border-l border-zinc-800 pl-3 ml-1'}>
      <div className="rounded-md border border-white/[0.05] bg-zinc-950/40 px-3 py-2.5">
        <div className="flex items-start gap-2">
          <div className={`mt-0.5 flex-shrink-0 ${style.className}`}>{style.icon}</div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-[13px] font-medium text-zinc-100">{node.role}</span>
              <span className={`text-[11px] ${style.className}`}>{node.statusLabel}</span>
              {cost && <span className="text-[11px] text-zinc-500">预算 {cost}</span>}
            </div>
            {progress && (
              <div className="mt-1 text-[12px] leading-relaxed text-zinc-300 line-clamp-2">
                {progress}
              </div>
            )}
            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-zinc-500">
              {activeTool && <span>正在用：{activeTool}</span>}
              {typeof node.budgetSummary.tokensUsed === 'number' && (
                <span>已用 {node.budgetSummary.tokensUsed.toLocaleString()} tokens</span>
              )}
              {typeof node.budgetSummary.usagePercent === 'number' && (
                <span>上下文 {Math.round(node.budgetSummary.usagePercent)}%</span>
              )}
            </div>
            {failureReason && (
              <div className="mt-2 rounded border border-rose-500/15 bg-rose-500/[0.05] px-2 py-1.5 text-[12px] text-rose-100">
                失败原因：{failureReason}
              </div>
            )}
            {hasWorktree && (
              <div className="mt-2 space-y-1.5 rounded border border-emerald-500/10 bg-emerald-500/[0.04] px-2 py-2">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-emerald-100">
                  {worktree.path && (
                    <span className="inline-flex min-w-0 items-center gap-1">
                      <FolderGit2 className="h-3 w-3 flex-shrink-0" />
                      <span className="truncate">{worktree.path}</span>
                    </span>
                  )}
                  {worktree.branch && (
                    <span className="inline-flex items-center gap-1">
                      <GitBranch className="h-3 w-3" />
                      {worktree.branch}
                    </span>
                  )}
                  {canReview && (
                    <button
                      type="button"
                      onClick={() => onReviewWorktree?.(node.id)}
                      className="inline-flex items-center gap-1 rounded border border-emerald-400/20 px-2 py-0.5 text-[11px] text-emerald-100 hover:bg-emerald-400/10 disabled:opacity-50"
                      disabled={isReviewLoading}
                    >
                      {isReviewLoading ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Eye className="h-3 w-3" />}
                      查看变更
                    </button>
                  )}
                </div>
                {changedFiles.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {changedFiles.slice(0, 6).map((file) => (
                      <span
                        key={`${file.status}:${file.path}`}
                        className="rounded bg-zinc-900/80 px-1.5 py-0.5 text-[11px] text-zinc-300"
                      >
                        {changedFileStatusLabel(file.status)} {file.path}
                      </span>
                    ))}
                    {changedFiles.length > 6 && (
                      <span className="rounded bg-zinc-900/80 px-1.5 py-0.5 text-[11px] text-zinc-500">
                        还有 {changedFiles.length - 6} 个文件
                      </span>
                    )}
                  </div>
                )}
                {diffSummary && <div className="text-[11px] text-zinc-400 whitespace-pre-wrap">{diffSummary}</div>}
                {diff && (
                  <pre className="max-h-44 overflow-auto rounded bg-zinc-950/80 p-2 text-[11px] leading-relaxed text-zinc-300 whitespace-pre-wrap">
                    {diff}
                  </pre>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      {node.children.length > 0 && (
        <div className="space-y-1">
          {node.children.map((child) => (
            <NodeLine
              key={child.id}
              node={child}
              depth={depth + 1}
              worktreeReviews={worktreeReviews}
              loadingReviewIds={loadingReviewIds}
              onReviewWorktree={onReviewWorktree}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export const AgentTreeSnapshotView: React.FC<AgentTreeSnapshotViewProps> = ({
  snapshot,
  worktreeReviews,
  loadingReviewIds,
  onReviewWorktree,
}) => {
  if (snapshot.nodes.length === 0) return null;

  return (
    <section className="rounded-md border border-white/[0.05] bg-white/[0.02] p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <GitBranch className="h-4 w-4 flex-shrink-0 text-emerald-300" />
          <h2 className="text-xs font-medium uppercase tracking-wide text-zinc-400">任务树</h2>
        </div>
        <div className="flex flex-wrap justify-end gap-1 text-[11px] text-zinc-500">
          {snapshot.summary.running > 0 && <span>进行中 {snapshot.summary.running}</span>}
          {snapshot.summary.completed > 0 && <span>完成 {snapshot.summary.completed}</span>}
          {(snapshot.summary.failed > 0 || snapshot.summary.blocked > 0) && (
            <span className="text-amber-300">需要处理 {snapshot.summary.failed + snapshot.summary.blocked}</span>
          )}
        </div>
      </div>
      <div className="space-y-1.5">
        {snapshot.roots.map((node) => (
          <NodeLine
            key={node.id}
            node={node}
            depth={0}
            worktreeReviews={worktreeReviews}
            loadingReviewIds={loadingReviewIds}
            onReviewWorktree={onReviewWorktree}
          />
        ))}
      </div>
    </section>
  );
};

export interface AgentTreeViewProps {
  snapshot?: AgentTreeSnapshot | null;
}

export const AgentTreeView: React.FC<AgentTreeViewProps> = ({ snapshot: providedSnapshot }) => {
  const { currentSessionId } = useSessionStore();
  const { snapshot: loadedSnapshot, refresh } = useAgentTreeSnapshot(
    currentSessionId,
    providedSnapshot === undefined,
  );
  const snapshot = providedSnapshot === undefined ? loadedSnapshot : providedSnapshot;
  const [worktreeReviews, setWorktreeReviews] = useState<Record<string, AgentWorktreeReview | undefined>>({});
  const [loadingReviewIds, setLoadingReviewIds] = useState<Set<string>>(() => new Set());

  const loadSnapshot = useCallback(async () => {
    if (providedSnapshot !== undefined) return;
    await refresh();
  }, [providedSnapshot, refresh]);

  const handleReviewWorktree = useCallback(async (agentId: string) => {
    setLoadingReviewIds((prev) => new Set(prev).add(agentId));
    try {
      const review = await ipcService.invokeDomain<AgentWorktreeReview | undefined>(
        IPC_DOMAINS.AGENT,
        'getWorktreeReview',
        { agentId },
      );
      setWorktreeReviews((prev) => ({ ...prev, [agentId]: review }));
      await loadSnapshot();
    } finally {
      setLoadingReviewIds((prev) => {
        const next = new Set(prev);
        next.delete(agentId);
        return next;
      });
    }
  }, [loadSnapshot]);

  const shouldRender = useMemo(() => Boolean(snapshot && snapshot.nodes.length > 0), [snapshot]);
  if (!shouldRender || !snapshot) return null;

  return (
    <AgentTreeSnapshotView
      snapshot={snapshot}
      worktreeReviews={worktreeReviews}
      loadingReviewIds={loadingReviewIds}
      onReviewWorktree={handleReviewWorktree}
    />
  );
};

export default AgentTreeView;
