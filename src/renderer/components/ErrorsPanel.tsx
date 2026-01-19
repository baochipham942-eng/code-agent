// ============================================================================
// ErrorsPanel - Error Tracking Visualization (Gen 3+ Persistent Planning)
// Shows 3-Strike Rule status for repeated errors
// ============================================================================

import React, { useState } from 'react';
import {
  AlertOctagon,
  ChevronDown,
  ChevronRight,
  Flame,
  AlertTriangle,
  Info,
  Terminal,
  Clock,
} from 'lucide-react';
import type { ErrorRecord } from '@shared/types';

interface ErrorsPanelProps {
  errors: ErrorRecord[];
  strikeLimit?: number;
  onRefresh?: () => void;
}

// Strike indicator (visual representation of error count)
const StrikeIndicator: React.FC<{ count: number; limit: number }> = ({
  count,
  limit,
}) => {
  const strikes = Array.from({ length: limit }, (_, i) => i < count);
  const isMaxed = count >= limit;

  return (
    <div className="flex items-center gap-1">
      {strikes.map((active, i) => (
        <div
          key={i}
          className={`w-2 h-2 rounded-full ${
            active
              ? isMaxed
                ? 'bg-red-500'
                : 'bg-orange-500'
              : 'bg-zinc-700'
          }`}
        />
      ))}
      {isMaxed && (
        <Flame className="w-3 h-3 text-red-500 ml-1 animate-pulse" />
      )}
    </div>
  );
};

// Severity badge based on error count
const SeverityBadge: React.FC<{ count: number; limit: number }> = ({
  count,
  limit,
}) => {
  if (count >= limit) {
    return (
      <span className="flex items-center gap-1 px-1.5 py-0.5 text-xs rounded bg-red-500/20 text-red-400">
        <AlertOctagon className="w-3 h-3" />
        Blocked
      </span>
    );
  }
  if (count >= limit - 1) {
    return (
      <span className="flex items-center gap-1 px-1.5 py-0.5 text-xs rounded bg-orange-500/20 text-orange-400">
        <AlertTriangle className="w-3 h-3" />
        Warning
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 px-1.5 py-0.5 text-xs rounded bg-zinc-500/20 text-zinc-400">
      <Info className="w-3 h-3" />
      Tracked
    </span>
  );
};

// Individual error item
const ErrorItem: React.FC<{ error: ErrorRecord; strikeLimit: number }> = ({
  error,
  strikeLimit,
}) => {
  const [expanded, setExpanded] = useState(false);
  const isBlocked = error.count >= strikeLimit;

  return (
    <div
      className={`border rounded-lg mb-2 ${
        isBlocked
          ? 'border-red-500/30 bg-red-500/5'
          : 'border-zinc-700 bg-zinc-800/30'
      }`}
    >
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-start gap-2 p-2 hover:bg-zinc-700/20 transition-colors rounded-lg"
      >
        {expanded ? (
          <ChevronDown className="w-4 h-4 text-zinc-400 mt-0.5 flex-shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 text-zinc-400 mt-0.5 flex-shrink-0" />
        )}
        <Terminal
          className={`w-4 h-4 mt-0.5 flex-shrink-0 ${
            isBlocked ? 'text-red-400' : 'text-orange-400'
          }`}
        />
        <div className="flex-1 text-left min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-mono text-zinc-200 truncate">
              {error.toolName}
            </span>
            <SeverityBadge count={error.count} limit={strikeLimit} />
          </div>
          <span className="text-xs text-zinc-500 line-clamp-1">
            {error.message}
          </span>
        </div>
        <StrikeIndicator count={error.count} limit={strikeLimit} />
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t border-zinc-700/50">
          {/* Error message */}
          <div className="mb-2">
            <span className="text-xs text-zinc-500 block mb-1">Error:</span>
            <p className="text-sm text-red-300 font-mono bg-zinc-900/50 p-2 rounded">
              {error.message}
            </p>
          </div>

          {/* Parameters if available */}
          {error.params && Object.keys(error.params).length > 0 && (
            <div className="mb-2">
              <span className="text-xs text-zinc-500 block mb-1">
                Parameters:
              </span>
              <pre className="text-xs text-zinc-400 font-mono bg-zinc-900/50 p-2 rounded overflow-x-auto">
                {JSON.stringify(error.params, null, 2)}
              </pre>
            </div>
          )}

          {/* Stack trace if available */}
          {error.stack && (
            <div className="mb-2">
              <span className="text-xs text-zinc-500 block mb-1">Stack:</span>
              <pre className="text-xs text-zinc-500 font-mono bg-zinc-900/50 p-2 rounded overflow-x-auto max-h-32">
                {error.stack}
              </pre>
            </div>
          )}

          {/* Timestamp and count */}
          <div className="flex items-center justify-between text-xs text-zinc-600 mt-2">
            <div className="flex items-center gap-1">
              <Clock className="w-3 h-3" />
              <span>{new Date(error.timestamp).toLocaleString()}</span>
            </div>
            <span>
              Occurred {error.count} time{error.count > 1 ? 's' : ''}
            </span>
          </div>

          {/* 3-Strike warning */}
          {isBlocked && (
            <div className="mt-2 p-2 bg-red-500/10 border border-red-500/30 rounded text-xs text-red-300">
              <strong>3-Strike Rule:</strong> This error pattern has reached the
              limit. A different approach is required.
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// Stats summary
const ErrorStats: React.FC<{ errors: ErrorRecord[]; strikeLimit: number }> = ({
  errors,
  strikeLimit,
}) => {
  const blockedCount = errors.filter((e) => e.count >= strikeLimit).length;
  const warningCount = errors.filter(
    (e) => e.count >= strikeLimit - 1 && e.count < strikeLimit
  ).length;
  const totalOccurrences = errors.reduce((sum, e) => sum + e.count, 0);

  return (
    <div className="flex items-center gap-3 text-xs">
      {blockedCount > 0 && (
        <span className="flex items-center gap-1 text-red-400">
          <AlertOctagon className="w-3 h-3" />
          {blockedCount} blocked
        </span>
      )}
      {warningCount > 0 && (
        <span className="flex items-center gap-1 text-orange-400">
          <AlertTriangle className="w-3 h-3" />
          {warningCount} warning
        </span>
      )}
      <span className="text-zinc-500">{totalOccurrences} total errors</span>
    </div>
  );
};

// Empty state
const EmptyState: React.FC = () => (
  <div className="flex flex-col items-center justify-center h-full text-center p-4">
    <AlertOctagon className="w-12 h-12 text-zinc-600 mb-3" />
    <p className="text-sm text-zinc-400">No errors tracked</p>
    <p className="text-xs text-zinc-500 mt-1">
      Errors will appear here when tools fail
    </p>
  </div>
);

// Main component
export const ErrorsPanel: React.FC<ErrorsPanelProps> = ({
  errors,
  strikeLimit = 3,
  onRefresh: _onRefresh,
}) => {
  // Sort by count (highest first), then by timestamp
  const sortedErrors = [...errors].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return b.timestamp - a.timestamp;
  });

  return (
    <div className="w-80 border-l border-zinc-800 bg-zinc-900/50 flex flex-col">
      {/* Header */}
      <div className="p-3 border-b border-zinc-800">
        <div className="flex items-center gap-2 mb-1">
          <AlertOctagon className="w-4 h-4 text-red-400" />
          <span className="text-sm font-medium text-zinc-100">
            Error Tracker
          </span>
          <span className="ml-auto text-xs text-zinc-500">
            3-Strike Rule
          </span>
        </div>
        {errors.length > 0 && (
          <ErrorStats errors={errors} strikeLimit={strikeLimit} />
        )}
      </div>

      {/* Errors list */}
      <div className="flex-1 overflow-y-auto p-2">
        {sortedErrors.length === 0 ? (
          <EmptyState />
        ) : (
          sortedErrors.map((error) => (
            <ErrorItem
              key={error.id}
              error={error}
              strikeLimit={strikeLimit}
            />
          ))
        )}
      </div>

      {/* Legend */}
      {errors.length > 0 && (
        <div className="p-2 border-t border-zinc-800">
          <div className="flex items-center justify-center gap-4 text-xs text-zinc-500">
            <div className="flex items-center gap-1">
              <div className="w-2 h-2 rounded-full bg-zinc-700" />
              <span>Available</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-2 h-2 rounded-full bg-orange-500" />
              <span>Strike</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-2 h-2 rounded-full bg-red-500" />
              <span>Blocked</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
