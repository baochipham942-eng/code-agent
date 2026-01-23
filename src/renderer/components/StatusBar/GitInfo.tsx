// ============================================================================
// GitInfo - Git 分支和工作目录信息
// ============================================================================

import React from 'react';
import { GitBranch, Folder } from 'lucide-react';
import { useStatusStore } from '../../stores/statusStore';

/**
 * 缩短路径显示
 * - 替换 home 目录为 ~
 * - 如果路径太长，只显示最后两级
 */
function shortenPath(path: string): string {
  // 在渲染进程中，不能直接访问 process.env.HOME
  // 使用一个简单的启发式方法：替换常见的 home 路径模式
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
  const { gitBranch, workingDirectory } = useStatusStore();

  // 如果没有任何信息，不渲染
  if (!gitBranch && !workingDirectory) {
    return null;
  }

  return (
    <div className="flex items-center gap-2 text-gray-400">
      {gitBranch && (
        <span className="flex items-center gap-1" title={`Branch: ${gitBranch}`}>
          <GitBranch size={12} />
          <span className="text-cyan-400">{gitBranch}</span>
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
