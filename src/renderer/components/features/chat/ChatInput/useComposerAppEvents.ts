// ============================================================================
// useComposerAppEvents — composer 相关的全局 window 事件订阅
// ----------------------------------------------------------------------------
// 从 ChatInput/index 原样搬出（N-EXTHISTORY-IMPORT-CHATS-RESUME 让位给导入会话
// 续聊的说明行，保持 index 净行数不涨）：命令面板与 seed composer 的两个
// app:open* 事件，纯订阅、无业务分支。
// ============================================================================

import { useEffect } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { SeedComposerKind } from './SeedComposerCard';

export function useComposerAppEvents(
  setShowCommandPalette: Dispatch<SetStateAction<boolean>>,
  setSeedComposer: Dispatch<SetStateAction<{ kind: SeedComposerKind; initialText: string } | null>>,
): void {
  useEffect(() => {
    const handleOpenCommandPalette = () => setShowCommandPalette(true);
    window.addEventListener('app:openCommandPalette', handleOpenCommandPalette);
    return () => {
      window.removeEventListener('app:openCommandPalette', handleOpenCommandPalette);
    };
  }, [setShowCommandPalette]);

  useEffect(() => {
    const handleOpenSeedComposer = (event: Event) => {
      const kind = (event as CustomEvent<{ kind?: SeedComposerKind }>).detail?.kind;
      if (kind === 'team' || kind === 'role') setSeedComposer({ kind, initialText: '' });
    };
    window.addEventListener('app:openSeedComposer', handleOpenSeedComposer);
    return () => window.removeEventListener('app:openSeedComposer', handleOpenSeedComposer);
  }, [setSeedComposer]);
}
