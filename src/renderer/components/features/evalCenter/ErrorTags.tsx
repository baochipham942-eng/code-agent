// ============================================================================
// ErrorTags - 错误分类标签云（对标 SpreadsheetBench Viewer Error Taxonomy）
// ============================================================================

import React from 'react';

interface ErrorTagsProps {
  errorTaxonomy: Record<string, number> | undefined;
}

export const ErrorTags: React.FC<ErrorTagsProps> = ({ errorTaxonomy }) => {
  if (!errorTaxonomy || Object.keys(errorTaxonomy).length === 0) return null;

  const sorted = Object.entries(errorTaxonomy).sort((a, b) => b[1] - a[1]);

  return (
    <div>
      <div className="text-xs font-medium text-zinc-400 mb-1.5">错误标签</div>
      <div className="flex flex-wrap gap-1.5">
        {sorted.map(([type, count]) => (
          <span
            key={type}
            className="text-[11px] px-2 py-0.5 rounded bg-red-500/15 text-red-400 border border-red-500/20"
          >
            {type} ×{count}
          </span>
        ))}
      </div>
    </div>
  );
};
