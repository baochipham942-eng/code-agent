// ============================================================================
// ToolHeader - Humanized step sentence (shortDescription, or humanizeToolStep
// fallback) + duration (no icon, no LoadingDots)
// Status is expressed by parent StatusIndicator
// ============================================================================

import React from 'react';
import type { ToolCall } from '@shared/contract';
import { formatDuration } from './utils';
import { getToolStatusLabel } from './statusLabels';
import type { ToolStatus } from './styles';
import { isSemanticToolUIEnabled } from '../../../../../utils/featureFlags';
import { humanizeToolStep } from '../../../../../utils/humanizeToolStep';
import { TargetContextIcon } from './TargetContextIcon';
import { useAppStore } from '../../../../../stores/appStore';
import { useI18n } from '../../../../../hooks/useI18n';
import { UI } from '@shared/constants';

interface Props {
  toolCall: ToolCall;
  status: ToolStatus;
}

/**
 * 构造 ToolHeader 的 hover tooltip：当模型 shortDescription 用 "..." 缩写了路径，
 * tooltip 兜底贴出完整的 file_path / path / command，让用户 hover 能看全。
 */
function buildToolHeaderTitle(toolCall: ToolCall, displayName: string): string {
  const args = (toolCall.arguments ?? {}) as Record<string, unknown>;
  const filePath = args.file_path ?? args.path;
  if (typeof filePath === 'string' && filePath && !displayName.includes(filePath)) {
    return `${displayName}\n${filePath}`;
  }
  if (typeof args.command === 'string' && args.command && !displayName.includes(args.command)) {
    return `${displayName}\n${args.command}`;
  }
  return displayName;
}

function getWriteFilePath(toolCall: ToolCall): string | null {
  if (toolCall.name !== 'Write') return null;
  if (toolCall.result && !toolCall.result.success) return null;

  const output = toolCall.result?.output;
  if (typeof output === 'string' && output) {
    const match = output.match(/(?:Created|Updated) file: (.+?)(?:\s+\(|\n|$)/);
    if (match) return match[1].trim();
  }

  const args = (toolCall.arguments ?? {}) as Record<string, unknown>;
  const filePath = args.file_path ?? args.path;
  return typeof filePath === 'string' && filePath ? filePath : null;
}

export function ToolHeader({ toolCall, status }: Props) {
  const openPreview = useAppStore((state) => state.openPreview);
  const workingDirectory = useAppStore((state) => state.workingDirectory);
  const { t } = useI18n();
  // 模型若提供了 shortDescription（产品视角语义标签），优先作为主标题展示；
  // 没有时 fallback 到 humanizeToolStep 合成的人话句子（读取了 xxx.md / 运行了命令 xxx），
  // 而不是裸露 "Read"/"Bash" 这类工具名——两条路径都已经是完整句子，不再需要
  // 单独的 params 副标题（避免语义重复）。
  const displayName = humanizeToolStep(
    toolCall.name,
    toolCall.arguments as Record<string, unknown> | undefined,
    t,
    toolCall.shortDescription,
  );
  const statusLabel = getToolStatusLabel(toolCall, status, t);
  const writeFilePath = getWriteFilePath(toolCall);
  const duration = toolCall.result?.duration;

  // feature flag 关闭时不展示 target icon（与 shortDescription gating 同步）
  const showTargetIcon = isSemanticToolUIEnabled() && !!toolCall.targetContext?.kind;
  const writeFileName = writeFilePath?.split('/').pop() || writeFilePath;
  const resolvedWritePath = writeFilePath && !writeFilePath.startsWith('/') && workingDirectory
    ? `${workingDirectory}/${writeFilePath}`
    : writeFilePath;

  return (
    <div className="flex items-center gap-2 flex-1 min-w-0">
      {/* Status label - dynamic per-tool text */}
      <span className="text-zinc-500 text-xs flex-shrink-0">{statusLabel}</span>

      {/* Target context icon — 让用户一眼认出"在操作哪个 app/服务" */}
      {showTargetIcon && (
        <TargetContextIcon targetContext={toolCall.targetContext} className="flex-shrink-0" />
      )}

      {/* Tool name - always semibold, neutral color */}
      {/* truncate + min-w-0 让长 shortDescription（如完整 Bash 命令）按 CSS 截断而不撑爆 layout；
          title 暴露完整文本便于 hover 看全（包含 args.file_path 等附加上下文） */}
      <span
        className="text-zinc-200 font-semibold truncate min-w-0"
        title={buildToolHeaderTitle(toolCall, displayName)}
      >
        {displayName}
      </span>

      {writeFilePath && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            if (resolvedWritePath) openPreview(resolvedWritePath);
          }}
          className="min-w-0 max-w-[260px] truncate text-xs font-mono text-zinc-400 transition-colors hover:text-emerald-400"
          title={writeFilePath}
        >
          {writeFileName}
        </button>
      )}

      {/* Duration - right aligned. 毫秒级耗时对非程序员是噪音，只在有感知意义时才显示 */}
      {duration !== undefined && status !== 'pending' && duration >= UI.TOOL_DURATION_MIN_VISIBLE_MS && (
        <span className="ml-auto text-zinc-600 text-xs flex-shrink-0">
          {formatDuration(duration)}
        </span>
      )}
    </div>
  );
}
