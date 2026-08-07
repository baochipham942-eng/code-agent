// ============================================================================
// ToolHeader - Humanized step sentence (shortDescription, or humanizeToolStep
// fallback) + optional clickable file path for right-pane preview
// Status is expressed by parent StatusIndicator
// ============================================================================

import React from 'react';
import type { ToolCall } from '@shared/contract';
import { getToolStatusLabel } from './statusLabels';
import type { ToolStatus } from './styles';
import { isSemanticToolUIEnabled } from '../../../../../utils/featureFlags';
import {
  deriveToolTargetContext,
  getToolFilePath,
  humanizeToolStep,
  isInternalStreamTool,
  toolNameForDetail,
} from '../../../../../utils/humanizeToolStep';
import { TargetContextIcon } from './TargetContextIcon';
import { useI18n } from '../../../../../hooks/useI18n';
import { useAppStore } from '../../../../../stores/appStore';

interface Props {
  toolCall: ToolCall;
  status: ToolStatus;
  /** 展开态：内部工具名进次级小字 */
  showDetailName?: boolean;
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

export function ToolHeader({ toolCall, status, showDetailName = false }: Props) {
  const { t } = useI18n();
  const openPreview = useAppStore((s) => s.openPreview);
  // 模型若提供了 shortDescription（产品视角语义标签），优先作为主标题展示；
  // 没有时 fallback 到 humanizeToolStep 合成的人话句子（读取了 xxx.md / 运行了命令 xxx），
  // 而不是裸露 "Read"/"Bash" 这类工具名——两条路径都已经是完整句子，不再需要
  // 单独的 params 副标题（避免语义重复）。
  const displayName = humanizeToolStep(
    toolCall.name,
    toolCall.arguments as Record<string, unknown> | undefined,
    t,
    toolCall.shortDescription,
    // 已失败的调用不再用过去时肯定式，避免与状态词同屏矛盾（结果语义交给状态词）
    toolCall.result?.success === false,
  );
  const statusLabel = getToolStatusLabel(toolCall, status, t);
  const filePath = getToolFilePath(
    toolCall.name,
    toolCall.arguments as Record<string, unknown> | undefined,
  );
  const showSecondaryName =
    showDetailName
    && (isInternalStreamTool(toolCall.name) || displayName === t.toolStepHumanize.fallback);

  // targetContext 不再由模型填（2026-08-07 从 _meta schema 与提示词里拿掉）。
  // 优先用 ToolCall 上已有的——那是宿主侧 cuaNarration 推的 app kind（真 app logo，
  // 这里推不出来），以及历史落库的行；没有才按工具名推。
  const targetContext = toolCall.targetContext
    ?? deriveToolTargetContext(toolCall.name, toolCall.arguments as Record<string, unknown> | undefined);
  // feature flag 关闭时不展示 target icon（与 shortDescription gating 同步）
  const showTargetIcon = isSemanticToolUIEnabled() && !!targetContext?.kind;

  const handleOpenPreview = (event: React.MouseEvent | React.KeyboardEvent) => {
    if (!filePath) return;
    event.preventDefault();
    event.stopPropagation();
    openPreview(filePath);
  };

  const title = buildToolHeaderTitle(toolCall, displayName);

  return (
    // 状态词 text-xs(12px) 与主文案 text-sm(14px) 同行混排：items-center 对齐的是
    // 盒子中心而非文字基线，基线会错开 0.5px（Retina 上 1 个物理像素），故用
    // items-baseline；图标不是文字，基线对齐会下沉，补 self-center。
    <div className="flex items-baseline gap-2 flex-1 min-w-0">
      {/* 状态词只在带结果数据时出现（getToolStatusLabel 成功且无数据时返回 null）：
          否则与主文案的动词重复。成败由左侧 StatusIndicator 表达。 */}
      {statusLabel && (
        <span className="text-zinc-500 text-xs flex-shrink-0">{statusLabel}</span>
      )}

      {/* Target context icon — 让用户一眼认出"在操作哪个 app/服务" */}
      {showTargetIcon && (
        <TargetContextIcon targetContext={targetContext} className="flex-shrink-0 self-center" />
      )}

      {/* 有文件路径时主行可点进右栏预览（读取了/编辑了/写入了 …）；
          点名字看文件，父行其余区域仍负责展开/折叠明细。 */}
      {filePath ? (
        <button
          type="button"
          data-testid="tool-header-open-preview"
          className="text-zinc-200 font-semibold truncate min-w-0 text-left hover:text-white hover:underline underline-offset-2"
          title={title}
          aria-label={t.toolStepHumanize.openPreviewAria.replace('{path}', filePath)}
          onClick={handleOpenPreview}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              handleOpenPreview(event);
            }
          }}
        >
          {displayName}
        </button>
      ) : (
        <span
          className="text-zinc-200 font-semibold truncate min-w-0"
          title={title}
        >
          {displayName}
        </span>
      )}

      {showSecondaryName && (
        <span className="flex-shrink-0 text-[10px] text-zinc-600 font-normal">
          {toolNameForDetail(toolCall.name)}
        </span>
      )}

      {/* 单个工具的裸秒数已去掉：一屏里原来有轮级「用时 30s」和每工具「2.6s」两套
          没说明关系的时间。「这段花了多久」由组头那一处回答（带 hover 说明），
          单步毫秒对非程序员没有可操作性。 */}
    </div>
  );
}
