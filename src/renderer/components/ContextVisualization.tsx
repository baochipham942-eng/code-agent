import React from 'react';

interface ContextVisualizationProps {
  tokenDistribution: { system: number; user: number; assistant: number; tool: number };
  totalTokens: number;
  maxTokens: number;
  compressionTimeline: Array<{ layer: string; timestamp: number; savedTokens: number }>;
  activeAgents: Array<{ id: string; type: string; status: string }>;
  deferredToolsCount: number;
}

export function ContextVisualization(props: ContextVisualizationProps) {
  const { tokenDistribution, totalTokens, maxTokens, compressionTimeline, activeAgents, deferredToolsCount } = props;
  const usagePercent = totalTokens / maxTokens;

  return (
    <div className="p-3 space-y-3 text-xs font-mono bg-gray-900 rounded-lg border border-gray-700">
      <h3 className="text-sm font-bold text-gray-200">Context Visualization</h3>

      {/* Stacked bar */}
      <div>
        <div className="text-gray-400 mb-1">Token Distribution ({totalTokens.toLocaleString()} / {maxTokens.toLocaleString()})</div>
        <div className="flex h-3 rounded overflow-hidden bg-gray-800">
          {Object.entries(tokenDistribution).map(([role, tokens]) => {
            const pct = (tokens / totalTokens) * 100;
            if (pct < 1) return null;
            const colors: Record<string, string> = {
              system: 'bg-purple-500', user: 'bg-blue-500',
              assistant: 'bg-green-500', tool: 'bg-yellow-500',
            };
            return <div key={role} className={`${colors[role] || 'bg-gray-500'}`} style={{ width: `${pct}%` }} title={`${role}: ${tokens}`} />;
          })}
        </div>
        <div className="flex gap-3 mt-1 text-gray-500">
          {Object.entries(tokenDistribution).map(([role, tokens]) => (
            <span key={role}>{role}: {tokens.toLocaleString()}</span>
          ))}
        </div>
      </div>

      {/* Compression timeline */}
      {compressionTimeline.length > 0 && (
        <div>
          <div className="text-gray-400 mb-1">Compression History</div>
          {compressionTimeline.map((entry, i) => (
            <div key={i} className="text-gray-500">
              {new Date(entry.timestamp).toLocaleTimeString()} — {entry.layer} (saved {entry.savedTokens} tokens)
            </div>
          ))}
        </div>
      )}

      {/* Active agents */}
      {activeAgents.length > 0 && (
        <div>
          <div className="text-gray-400 mb-1">Active Agents ({activeAgents.length})</div>
          {activeAgents.map(agent => (
            <div key={agent.id} className="text-gray-500">
              {agent.type} [{agent.status}]
            </div>
          ))}
        </div>
      )}

      {/* Deferred tools */}
      {deferredToolsCount > 0 && (
        <div className="text-gray-500">Deferred tools: {deferredToolsCount}</div>
      )}
    </div>
  );
}
