import type { AppshotCapture } from '@shared/contract/appshot';
import { AppshotChip } from './AppshotChip';
import { PinnedLibraryChips } from './PinnedLibraryChips';

interface ComposerChipsRowProps {
  pendingAppshot: AppshotCapture | null;
  clearAppshot: () => void;
}

// 文字区上方 chip（非文字流内容）：appshot、pin 资料。
// 命令 / 当轮 skill / @文件附件已内联进文字流（InputArea 的 inlineChips，
// 2026-07-29 WorkBuddy phrase chip 模型）；专家在底栏有专门位置，
// 会话级挂载（MCP/连接器）在底栏权限徽章旁（MountedConnectorIcons），都不进这里。
// @neo 续接 chip 已随 @neo 交互一并从 composer 移除（2026-07-29 拍板）。
export function ComposerChipsRow({ pendingAppshot, clearAppshot }: ComposerChipsRowProps) {
  return (
    <>
      {pendingAppshot && (
        <div className="mb-2">
          <AppshotChip capture={pendingAppshot} onRemove={clearAppshot} />
        </div>
      )}
      <PinnedLibraryChips />
    </>
  );
}
