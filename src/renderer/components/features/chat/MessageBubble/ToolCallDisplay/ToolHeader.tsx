// ============================================================================
// ToolHeader - Humanized step sentence (shortDescription, or humanizeToolStep
// fallback) + duration (no icon, no LoadingDots)
// Status is expressed by parent StatusIndicator
// ============================================================================

import React from 'react';
import type { ToolCall } from '@shared/contract';
import { getToolStatusLabel } from './statusLabels';
import type { ToolStatus } from './styles';
import { isSemanticToolUIEnabled } from '../../../../../utils/featureFlags';
import { humanizeToolStep } from '../../../../../utils/humanizeToolStep';
import { TargetContextIcon } from './TargetContextIcon';
import { useI18n } from '../../../../../hooks/useI18n';

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

export function ToolHeader({ toolCall, status }: Props) {
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

  // feature flag 关闭时不展示 target icon（与 shortDescription gating 同步）
  const showTargetIcon = isSemanticToolUIEnabled() && !!toolCall.targetContext?.kind;

  return (
    <div className="flex items-center gap-2 flex-1 min-w-0">
      {/* 状态词只在带结果数据时出现（getToolStatusLabel 成功且无数据时返回 null）：
          否则与主文案的动词重复。成败由左侧 StatusIndicator 表达。 */}
      {statusLabel && (
        <span className="text-zinc-500 text-xs flex-shrink-0">{statusLabel}</span>
      )}

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

      {/* 单个工具的裸秒数已去掉：一屏里原来有轮级「用时 30s」和每工具「2.6s」两套
          没说明关系的时间。「这段花了多久」由组头那一处回答（带 hover 说明），
          单步毫秒对非程序员没有可操作性。 */}
    </div>
  );
}
