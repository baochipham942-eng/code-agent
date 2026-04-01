// ============================================================================
// ContextPanel - /context observability surface
// Shows the API true-view after projection: token usage, distribution,
// compression status, and per-message preview.
// ============================================================================

import React, { useState, useCallback } from 'react';
import type { ContextViewResponse } from '../../main/ipc/context.ipc';

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function formatTokens(n: number): string {
  return n.toLocaleString();
}

function usageBarColor(percent: number): string {
  if (percent >= 85) return 'bg-red-500';
  if (percent >= 60) return 'bg-yellow-400';
  return 'bg-emerald-500';
}

function usageTextColor(percent: number): string {
  if (percent >= 85) return 'text-red-400';
  if (percent >= 60) return 'text-yellow-400';
  return 'text-emerald-400';
}

// ----------------------------------------------------------------------------
// Sub-components
// ----------------------------------------------------------------------------

const TokenBar: React.FC<{ percent: number; total: number; max: number }> = ({
  percent,
  total,
  max,
}) => (
  <div className="space-y-1.5">
    <div className="h-2 w-full rounded-full bg-zinc-700 overflow-hidden">
      <div
        className={`h-full transition-all duration-300 ${usageBarColor(percent)}`}
        style={{ width: `${Math.min(percent, 100)}%` }}
      />
    </div>
    <div className="flex justify-between text-xs font-mono">
      <span className="text-zinc-400">
        {formatTokens(total)} / {formatTokens(max)} tokens
      </span>
      <span className={`font-semibold ${usageTextColor(percent)}`}>
        {percent.toFixed(1)}%
      </span>
    </div>
  </div>
);

const DistributionBox: React.FC<{ label: string; tokens: number; colorClass: string }> = ({
  label,
  tokens,
  colorClass,
}) => (
  <div className="flex flex-col items-center rounded-lg bg-zinc-800 px-3 py-2 gap-1 min-w-0">
    <span className={`text-xs font-medium uppercase tracking-wide ${colorClass}`}>{label}</span>
    <span className="text-sm font-mono text-zinc-200">{formatTokens(tokens)}</span>
  </div>
);

const CompressionRow: React.FC<{ label: string; value: string | number }> = ({ label, value }) => (
  <div className="flex justify-between text-xs">
    <span className="text-zinc-500">{label}</span>
    <span className="text-zinc-300 font-mono">{value}</span>
  </div>
);

const MessagePreviewItem: React.FC<{
  id: string;
  role: string;
  contentPreview: string;
  tokens: number;
}> = ({ role, contentPreview, tokens }) => {
  const roleColor: Record<string, string> = {
    system: 'text-purple-400',
    user: 'text-sky-400',
    assistant: 'text-emerald-400',
    tool: 'text-orange-400',
  };
  const color = roleColor[role] ?? 'text-zinc-400';

  return (
    <div className="flex gap-2 items-start py-1.5 border-b border-zinc-800 last:border-0">
      <span className={`text-xs font-semibold uppercase w-16 shrink-0 pt-0.5 ${color}`}>
        {role}
      </span>
      <span className="text-xs text-zinc-400 flex-1 break-words leading-relaxed font-mono">
        {contentPreview}
      </span>
      <span className="text-xs text-zinc-600 font-mono shrink-0 pt-0.5">{tokens}t</span>
    </div>
  );
};

// ----------------------------------------------------------------------------
// Main component
// ----------------------------------------------------------------------------

export const ContextPanel: React.FC = () => {
  const [data, setData] = useState<ContextViewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI?.invoke('context:getView', { sessionId: '' });
      setData((result as ContextViewResponse) ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <div className="flex flex-col gap-4 p-4 text-sm">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-zinc-100">Context View</h2>
        <button
          onClick={refresh}
          disabled={loading}
          className="px-3 py-1.5 text-xs rounded-md bg-zinc-700 text-zinc-200 hover:bg-zinc-600 disabled:opacity-50 transition-colors"
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {error && (
        <div className="rounded-md bg-red-500/20 px-3 py-2 text-xs text-red-300">{error}</div>
      )}

      {!data && !loading && (
        <p className="text-xs text-zinc-500">Click Refresh to load the current context view.</p>
      )}

      {data && (
        <>
          {/* 1. Token usage bar */}
          <section className="space-y-1">
            <h3 className="text-xs font-medium uppercase tracking-wide text-zinc-500">
              Token Usage
            </h3>
            <TokenBar
              percent={data.usagePercent}
              total={data.totalTokens}
              max={data.maxTokens}
            />
          </section>

          {/* 2. Token distribution */}
          <section className="space-y-1.5">
            <h3 className="text-xs font-medium uppercase tracking-wide text-zinc-500">
              Distribution ({data.messageCount} messages)
            </h3>
            <div className="grid grid-cols-4 gap-2">
              <DistributionBox
                label="System"
                tokens={data.tokenDistribution.system}
                colorClass="text-purple-400"
              />
              <DistributionBox
                label="User"
                tokens={data.tokenDistribution.user}
                colorClass="text-sky-400"
              />
              <DistributionBox
                label="Asst"
                tokens={data.tokenDistribution.assistant}
                colorClass="text-emerald-400"
              />
              <DistributionBox
                label="Tool"
                tokens={data.tokenDistribution.tool}
                colorClass="text-orange-400"
              />
            </div>
          </section>

          {/* 3. Compression status */}
          <section className="space-y-1.5">
            <h3 className="text-xs font-medium uppercase tracking-wide text-zinc-500">
              Compression
            </h3>
            <div className="rounded-lg bg-zinc-800/60 px-3 py-2 space-y-1.5">
              <CompressionRow
                label="Layers triggered"
                value={
                  data.compressionStatus.layersTriggered.length > 0
                    ? data.compressionStatus.layersTriggered.join(', ')
                    : '—'
                }
              />
              <CompressionRow label="Total commits" value={data.compressionStatus.totalCommits} />
              <CompressionRow label="Snipped" value={data.compressionStatus.snippedCount} />
              <CompressionRow
                label="Collapsed spans"
                value={data.compressionStatus.collapsedSpans}
              />
              <CompressionRow
                label="Tokens saved"
                value={formatTokens(data.compressionStatus.savedTokens)}
              />
            </div>
          </section>

          {/* 4. API view preview */}
          <section className="space-y-1.5">
            <h3 className="text-xs font-medium uppercase tracking-wide text-zinc-500">
              API View Preview
            </h3>
            <div className="rounded-lg bg-zinc-800/60 px-3 py-1 max-h-64 overflow-y-auto">
              {data.apiViewPreview.length === 0 ? (
                <p className="text-xs text-zinc-600 py-2">No messages in API view.</p>
              ) : (
                data.apiViewPreview.map((msg) => (
                  <MessagePreviewItem
                    key={msg.id}
                    id={msg.id}
                    role={msg.role}
                    contentPreview={msg.contentPreview}
                    tokens={msg.tokens}
                  />
                ))
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
};

export default ContextPanel;
