// ============================================================================
// RequestDetails - 权限请求详情组件
// ============================================================================

import React from 'react';
import type { PermissionRequest } from './types';
import { formatFilePath } from './utils';

interface RequestDetailsProps {
  request: PermissionRequest;
}

export function RequestDetails({ request }: RequestDetailsProps) {
  const { type, details } = request;

  // 兼容旧版 API：path -> filePath
  const filePath = details.filePath || details.path;

  return (
    <div className="space-y-3">
      {/* 文件路径 */}
      {filePath && <DetailItem label="文件" value={filePath} isPath />}

      {/* 命令 */}
      {details.command && (
        <DetailItem
          label="命令"
          value={details.command}
          isCode
          isDangerous={type === 'dangerous_command'}
        />
      )}

      {/* URL */}
      {details.url && <DetailItem label="URL" value={details.url} isUrl />}

      {/* MCP 工具 */}
      {details.server && details.toolName && (
        <DetailItem label="MCP 工具" value={`${details.server} / ${details.toolName}`} />
      )}

      {/* 编辑预览（简化版，显示变更内容） */}
      {type === 'file_edit' && details.changes && (
        <div className="mt-4">
          <div className="text-xs text-zinc-500 mb-2">变更内容</div>
          <pre
            className="
              text-xs p-2 rounded
              bg-amber-500/10 border border-amber-500/20
              text-amber-300
              overflow-x-auto max-h-32
              whitespace-pre-wrap break-all
            "
          >
            {details.changes.length > 500
              ? `${details.changes.slice(0, 500)}...`
              : details.changes}
          </pre>
        </div>
      )}
    </div>
  );
}

// 详情项组件
interface DetailItemProps {
  label: string;
  value: string;
  isPath?: boolean;
  isCode?: boolean;
  isUrl?: boolean;
  isDangerous?: boolean;
}

function DetailItem({ label, value, isPath, isCode, isUrl, isDangerous }: DetailItemProps) {
  // 格式化显示值
  const displayValue = isPath ? formatFilePath(value) : value;

  return (
    <div>
      <div className="text-xs text-zinc-500 mb-1">{label}</div>
      <div
        className={`
          p-2 rounded font-mono text-sm
          break-all
          ${
            isCode
              ? isDangerous
                ? 'bg-red-500/10 border border-red-500/20 text-red-300'
                : 'bg-zinc-800 border border-zinc-700 text-zinc-300'
              : ''
          }
          ${isPath ? 'bg-zinc-800/50 text-blue-400' : ''}
          ${isUrl ? 'bg-zinc-800/50 text-cyan-400' : ''}
          ${!isCode && !isPath && !isUrl ? 'bg-zinc-800/50 text-zinc-300' : ''}
        `}
        title={value}
      >
        {displayValue}
      </div>
    </div>
  );
}
