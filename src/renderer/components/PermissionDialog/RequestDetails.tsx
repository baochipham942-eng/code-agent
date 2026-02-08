// ============================================================================
// RequestDetails - 权限请求详情组件
// ============================================================================

import React, { useState } from 'react';
import type { PermissionRequest } from './types';
import { formatFilePath } from './utils';
import { DiffView } from '../DiffView';

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

      {/* 确认门控 Diff 预览（E2） */}
      {details.preview?.type === 'diff' && details.preview.before != null && details.preview.after != null && (
        <ConfirmationDiffPreview
          before={details.preview.before}
          after={details.preview.after}
          summary={details.preview.summary}
          filePath={filePath}
        />
      )}

      {/* 确认门控 非 diff 预览（命令/网络/通用） */}
      {details.preview && details.preview.type !== 'diff' && (
        <div className="mt-4">
          <div className="text-xs text-zinc-500 mb-2">{details.preview.summary}</div>
          {details.preview.diff && (
            <pre className="text-xs p-2 rounded bg-zinc-800 border border-zinc-700 text-zinc-300 overflow-x-auto max-h-32 whitespace-pre-wrap break-all">
              {details.preview.diff}
            </pre>
          )}
        </div>
      )}

      {/* 编辑预览（简化版，显示变更内容） - 仅在无 diff 预览时显示 */}
      {type === 'file_edit' && details.changes && !details.preview && (
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

// ----------------------------------------------------------------------------
// ConfirmationDiffPreview - E2 确认门控 Diff 预览
// ----------------------------------------------------------------------------

interface ConfirmationDiffPreviewProps {
  before: string;
  after: string;
  summary: string;
  filePath?: string;
}

function ConfirmationDiffPreview({ before, after, summary, filePath }: ConfirmationDiffPreviewProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="mt-4">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs text-zinc-500">{summary}</div>
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-[10px] text-blue-400 hover:text-blue-300"
        >
          {expanded ? '收起' : '展开 Diff'}
        </button>
      </div>
      {expanded && (
        <div className="max-h-48 overflow-y-auto rounded border border-zinc-700/50">
          <DiffView
            oldText={before}
            newText={after}
            fileName={filePath?.split('/').pop()}
          />
        </div>
      )}
    </div>
  );
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
