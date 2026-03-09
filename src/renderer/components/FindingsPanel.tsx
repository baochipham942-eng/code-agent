// ============================================================================
// FindingsPanel - Research Findings Visualization (Gen 3+ Persistent Planning)
// ============================================================================

import React, { useState } from 'react';
import {
  Lightbulb,
  Code2,
  GitBranch,
  Package,
  AlertTriangle,
  Sparkles,
  ChevronDown,
  ChevronRight,
  FileSearch,
  ExternalLink,
} from 'lucide-react';
import type { Finding, FindingCategory } from '@shared/types';

interface FindingsPanelProps {
  findings: Finding[];
  onRefresh?: () => void;
}

// Category icons and colors
const categoryConfig: Record<
  FindingCategory,
  { icon: React.FC<{ className?: string }>; color: string; label: string }
> = {
  code: {
    icon: Code2,
    color: 'text-blue-400',
    label: 'Code',
  },
  architecture: {
    icon: GitBranch,
    color: 'text-purple-400',
    label: 'Architecture',
  },
  dependency: {
    icon: Package,
    color: 'text-orange-400',
    label: 'Dependency',
  },
  issue: {
    icon: AlertTriangle,
    color: 'text-red-400',
    label: 'Issue',
  },
  insight: {
    icon: Sparkles,
    color: 'text-green-400',
    label: 'Insight',
  },
};

// Individual finding item
const FindingItem: React.FC<{ finding: Finding }> = ({ finding }) => {
  const [expanded, setExpanded] = useState(false);
  const config = categoryConfig[finding.category];
  const Icon = config.icon;

  return (
    <div className="border border-border-default rounded-lg mb-2 bg-surface">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-start gap-2 p-2 hover:bg-active/20 transition-colors rounded-lg"
      >
        {expanded ? (
          <ChevronDown className="w-4 h-4 text-text-secondary mt-0.5 flex-shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 text-text-secondary mt-0.5 flex-shrink-0" />
        )}
        <Icon className={`w-4 h-4 ${config.color} mt-0.5 flex-shrink-0`} />
        <div className="flex-1 text-left">
          <span className="text-sm text-text-primary block">{finding.title}</span>
          {!expanded && (
            <span className="text-xs text-text-tertiary line-clamp-1">
              {finding.content}
            </span>
          )}
        </div>
        <span className={`text-xs ${config.color} flex-shrink-0`}>
          {config.label}
        </span>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t border-border-default">
          <p className="text-sm text-text-secondary whitespace-pre-wrap">
            {finding.content}
          </p>
          {finding.source && (
            <div className="mt-2 flex items-center gap-1 text-xs text-text-tertiary">
              <ExternalLink className="w-3 h-3" />
              <span className="truncate">{finding.source}</span>
            </div>
          )}
          <div className="mt-2 text-xs text-text-disabled">
            {new Date(finding.timestamp).toLocaleString()}
          </div>
        </div>
      )}
    </div>
  );
};

// Category filter tabs
const CategoryTabs: React.FC<{
  findings: Finding[];
  activeCategory: FindingCategory | 'all';
  onChange: (category: FindingCategory | 'all') => void;
}> = ({ findings, activeCategory, onChange }) => {
  // Count findings by category
  const counts: Record<FindingCategory | 'all', number> = {
    all: findings.length,
    code: findings.filter((f) => f.category === 'code').length,
    architecture: findings.filter((f) => f.category === 'architecture').length,
    dependency: findings.filter((f) => f.category === 'dependency').length,
    issue: findings.filter((f) => f.category === 'issue').length,
    insight: findings.filter((f) => f.category === 'insight').length,
  };

  const categories: Array<FindingCategory | 'all'> = [
    'all',
    'code',
    'architecture',
    'dependency',
    'issue',
    'insight',
  ];

  return (
    <div className="flex flex-wrap gap-1 p-2 border-b border-border-default">
      {categories.map((cat) => {
        if (cat === 'all') {
          return (
            <button
              key={cat}
              onClick={() => onChange(cat)}
              className={`px-2 py-1 text-xs rounded-md transition-colors ${
                activeCategory === cat
                  ? 'bg-active text-text-primary'
                  : 'text-text-secondary hover:text-text-primary hover:bg-hover'
              }`}
            >
              All ({counts.all})
            </button>
          );
        }

        const config = categoryConfig[cat];
        const Icon = config.icon;
        if (counts[cat] === 0) return null;

        return (
          <button
            key={cat}
            onClick={() => onChange(cat)}
            className={`flex items-center gap-1 px-2 py-1 text-xs rounded-md transition-colors ${
              activeCategory === cat
                ? 'bg-active text-text-primary'
                : 'text-text-secondary hover:text-text-primary hover:bg-hover'
            }`}
          >
            <Icon className={`w-3 h-3 ${config.color}`} />
            <span>{counts[cat]}</span>
          </button>
        );
      })}
    </div>
  );
};

// Empty state
const EmptyState: React.FC = () => (
  <div className="flex flex-col items-center justify-center h-full text-center p-4">
    <FileSearch className="w-12 h-12 text-text-disabled mb-3" />
    <p className="text-sm text-text-secondary">No findings yet</p>
    <p className="text-xs text-text-tertiary mt-1">
      Use findings_write to save research discoveries
    </p>
  </div>
);

// Main component
export const FindingsPanel: React.FC<FindingsPanelProps> = ({
  findings,
  onRefresh: _onRefresh,
}) => {
  const [activeCategory, setActiveCategory] = useState<FindingCategory | 'all'>(
    'all'
  );

  const filteredFindings =
    activeCategory === 'all'
      ? findings
      : findings.filter((f) => f.category === activeCategory);

  // Sort by timestamp, newest first
  const sortedFindings = [...filteredFindings].sort(
    (a, b) => b.timestamp - a.timestamp
  );

  return (
    <div className="w-80 border-l border-border-default bg-deep flex flex-col">
      {/* Header */}
      <div className="p-3 border-b border-border-default">
        <div className="flex items-center gap-2">
          <Lightbulb className="w-4 h-4 text-yellow-400" />
          <span className="text-sm font-medium text-text-primary">Findings</span>
          <span className="ml-auto text-xs text-text-tertiary">
            {findings.length} total
          </span>
        </div>
      </div>

      {/* Category tabs */}
      {findings.length > 0 && (
        <CategoryTabs
          findings={findings}
          activeCategory={activeCategory}
          onChange={setActiveCategory}
        />
      )}

      {/* Findings list */}
      <div className="flex-1 overflow-y-auto p-2">
        {sortedFindings.length === 0 ? (
          <EmptyState />
        ) : (
          sortedFindings.map((finding) => (
            <FindingItem key={finding.id} finding={finding} />
          ))
        )}
      </div>
    </div>
  );
};
