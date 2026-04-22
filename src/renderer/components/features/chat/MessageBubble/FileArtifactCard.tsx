// ============================================================================
// FileArtifactCard - 把 AI 修改/创建的文件作为独立卡片呈现
// 借鉴 CodePilot v0.52.0 的 Artifact 卡片设计
// 输入直接用 TurnArtifactOwnershipItem，复用既有数据层
// ============================================================================

import React from 'react';
import {
  FileText, Code, Image as ImageIcon, FileSpreadsheet, Eye, File,
} from 'lucide-react';
import type { TurnArtifactOwnershipItem } from '@shared/contract/turnTimeline';
import { useAppStore } from '../../../../stores/appStore';

const PREVIEWABLE_EXTENSIONS = new Set([
  'md', 'mdx', 'html', 'htm', 'jsx', 'tsx', 'csv', 'tsv', 'txt',
]);

interface Props {
  items: TurnArtifactOwnershipItem[];
}

function getExt(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : '';
}

// ownerLabel 格式："<tool>" 或 "<agent> · <tool>"，取最后一段作为工具名
function extractToolName(ownerLabel: string): string {
  const parts = ownerLabel.split(' · ');
  return parts[parts.length - 1] || ownerLabel;
}

function pickIcon(ext: string): React.ReactNode {
  const cls = 'w-3.5 h-3.5 flex-shrink-0';
  if (['md', 'mdx', 'txt'].includes(ext)) return <FileText className={`${cls} text-zinc-400`} />;
  if (['html', 'htm'].includes(ext)) return <Code className={`${cls} text-orange-400`} />;
  if (['jsx', 'tsx', 'js', 'ts'].includes(ext)) return <Code className={`${cls} text-blue-400`} />;
  if (['csv', 'tsv'].includes(ext)) return <FileSpreadsheet className={`${cls} text-green-400`} />;
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return <ImageIcon className={`${cls} text-emerald-400`} />;
  return <File className={`${cls} text-zinc-500`} />;
}

export const FileArtifactCard: React.FC<Props> = ({ items }) => {
  const openPreview = useAppStore((s) => s.openPreview);

  if (items.length === 0) return null;

  const entries = items.map((item) => {
    const ext = getExt(item.label);
    const toolName = extractToolName(item.ownerLabel);
    return {
      item,
      ext,
      toolName,
      status: toolName === 'Write' ? ('created' as const) : ('modified' as const),
      previewable: PREVIEWABLE_EXTENSIONS.has(ext),
    };
  });

  const previewable = entries.filter((e) => e.previewable);
  const others = entries.filter((e) => !e.previewable);

  return (
    <div className="space-y-1.5">
      {previewable.map(({ item, ext, status }) => (
        <div
          key={`${item.sourceNodeId || ''}:${item.path || item.label}`}
          className="flex items-center gap-2 px-3 py-2 rounded-lg bg-zinc-800/60 border border-zinc-700 hover:border-zinc-600 transition-colors"
          title={item.path || item.label}
        >
          {pickIcon(ext)}

          <span className="text-xs text-zinc-200 font-medium truncate flex-1 min-w-0">
            {item.label}
          </span>

          <span
            className={`px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0 ${
              status === 'created'
                ? 'bg-emerald-500/15 text-emerald-400'
                : 'bg-amber-500/15 text-amber-400'
            }`}
          >
            {status === 'created' ? 'Created' : 'Modified'}
          </span>

          {item.path && (
            <button
              onClick={() => openPreview(item.path!)}
              className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700 transition-colors flex-shrink-0"
              title="在预览面板打开"
            >
              <Eye className="w-3 h-3" />
              <span>Open preview</span>
            </button>
          )}
        </div>
      ))}

      {others.length > 0 && (
        <div
          className="text-[11px] text-zinc-500 px-1 truncate"
          title={others.map((e) => e.item.path || e.item.label).join('\n')}
        >
          <span className="text-zinc-600">Also modified:</span>{' '}
          {others.map((e) => e.item.label).join(', ')}
        </div>
      )}
    </div>
  );
};
