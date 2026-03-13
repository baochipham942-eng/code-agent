// ============================================================================
// GitInfo - Git 分支、工作目录和变更状态信息
// ============================================================================

import React from 'react';
import { GitBranch, Folder, CircleDot, Plus, FileEdit } from 'lucide-react';
import { useStatusStore } from '../../stores/statusStore';

/**
 * 缩短路径显示
 * - 替换 home 目录为 ~
 * - 如果路径太长，只显示最后两级
 */
function shortenPath(path: string): string {
  let shortened = path;

  // macOS/Linux home 路径模式
  const homeMatch = path.match(/^\/Users\/[^/]+/);
  if (homeMatch) {
    shortened = path.replace(homeMatch[0], '~');
  }

  // 如果路径太长，只显示最后两级
  const parts = shortened.split('/').filter(Boolean);
  if (parts.length > 3) {
    shortened = '.../' + parts.slice(-2).join('/');
  }

  return shortened;
}

export function GitInfo() {
  const { gitBranch, workingDirectory, gitChanges } = useStatusStore();

  // 如果没有任何信息，不渲染
  if (!gitBranch && !workingDirectory) {
    return null;
  }

  const hasChanges = gitChanges && (gitChanges.staged > 0 || gitChanges.unstaged > 0 || gitChanges.untracked > 0);

  return (
    <div className="flex items-center gap-2 text-gray-400">
      {gitBranch && (
        <span className="flex items-center gap-1" title={`Branch: ${gitBranch}`}>
          <GitBranch size={12} />
          <span className="text-cyan-400">{gitBranch}</span>
        </span>
      )}
      {hasChanges && (
        <span className="flex items-center gap-1 text-xs" title={`Staged: ${gitChanges.staged} | Unstaged: ${gitChanges.unstaged} | Untracked: ${gitChanges.untracked}`}>
          {gitChanges.staged > 0 && (
            <span className="flex items-center gap-0.5 text-green-400">
              <CircleDot size={10} />
              {gitChanges.staged}
            </span>
          )}
          {gitChanges.unstaged > 0 && (
            <span className="flex items-center gap-0.5 text-yellow-400">
              <FileEdit size={10} />
              {gitChanges.unstaged}
            </span>
          )}
          {gitChanges.untracked > 0 && (
            <span className="flex items-center gap-0.5 text-gray-500">
              <Plus size={10} />
              {gitChanges.untracked}
            </span>
          )}
        </span>
      )}
      {workingDirectory && (
        <span
          className="flex items-center gap-1"
          title={`Working directory: ${workingDirectory}`}
        >
          <Folder size={12} />
          <span className="truncate max-w-32">
            {shortenPath(workingDirectory)}
          </span>
        </span>
      )}
    </div>
  );
}
