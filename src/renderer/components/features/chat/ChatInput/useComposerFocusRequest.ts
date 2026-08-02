import { useEffect } from 'react';
import { useAppStore } from '../../../../stores/appStore';

/**
 * 「新建会话」落在一个已经打开的空白草稿上时，既不切换也不新建——屏幕零变化，
 * 那次点击看起来像没反应。store 递增 `composerFocusNonce` 作为唯一回执，
 * 这里把光标交还输入框。
 *
 * 初始值 0 不触发，避免每次挂载都抢焦点。
 */
export function useComposerFocusRequest(focusComposer: () => void): void {
  const composerFocusNonce = useAppStore((state) => state.composerFocusNonce);
  useEffect(() => {
    if (composerFocusNonce === 0) return;
    focusComposer();
  }, [composerFocusNonce, focusComposer]);
}
