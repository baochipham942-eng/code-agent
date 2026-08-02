import type { RefObject } from 'react';
import type { AppshotCapture } from '@shared/contract/appshot';
import { useAppshotsStore } from '../../../../stores/appshotsStore';
import { AppshotChip } from './AppshotChip';
import { PinnedLibraryChips } from './PinnedLibraryChips';

interface ComposerChipsRowProps {
  pendingAppshot: AppshotCapture | null;
  clearAppshot: () => void;
  /**
   * Appshot 飞入落点锚：与 chip 缩略图矩形完全重合——卡片按钮 border 1px + p-2，
   * 缩略图 w-60 h-[7.5rem] 贴卡片上缘，其下缘距卡下缘 35px（gap-1.5 6 + 标题行 h-5 20
   * + p-2 8 + border 1）。
   * 关键：用 bottom 而非 top 锚定——捕获时本行可能为空（高度 0），reserved chip 挂载后
   * 行才向上长高；bottom 锚定在空/满两种状态下上报的矩形一致，top 锚定会让飞入落到
   * 「空行位置」与真实缩略图错位。
   * 空闲时也在 DOM（不占布局），上报真实 getBoundingClientRect 给 Rust 算落点。
   */
  appshotSlotRef: RefObject<HTMLDivElement | null>;
}

// 文字区上方 chip（非文字流内容）：appshot、pin 资料。
// 命令 / 当轮 skill / @文件附件已内联进文字流（InputArea 的 inlineChips，
// 2026-07-29 WorkBuddy phrase chip 模型）；专家在底栏有专门位置，
// 会话级挂载（MCP/连接器）在底栏权限徽章旁（MountedConnectorIcons），都不进这里。
// @neo 续接 chip 已随 @neo 交互一并从 composer 移除（2026-07-29 拍板）。
export function ComposerChipsRow({ pendingAppshot, clearAppshot, appshotSlotRef }: ComposerChipsRowProps) {
  // reserved = 截图已就绪、等 overlay 飞抵后的 handoff 再零位移显形（无双影）
  const reserved = useAppshotsStore((s) => s.phase === 'reserved');
  return (
    <>
      {/* mb-2 恒定（不随 pending 有无变化）：保持锚点下缘到输入框的距离恒定，
          否则空行上报的落点与 chip 出现后的真实位置差一个 margin */}
      <div className="relative mb-2">
        <div
          ref={appshotSlotRef}
          aria-hidden
          className="pointer-events-none absolute left-[9px] bottom-[35px] w-60 h-[7.5rem] opacity-0"
        />
        {pendingAppshot && (
          <AppshotChip
            key={pendingAppshot.requestId}
            capture={pendingAppshot}
            onRemove={clearAppshot}
            reserved={reserved}
          />
        )}
      </div>
      <PinnedLibraryChips />
    </>
  );
}
