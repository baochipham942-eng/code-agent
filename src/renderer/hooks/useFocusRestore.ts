// ============================================================================
// useFocusRestore - 焦点恢复 Hook
// 组件卸载时恢复之前的焦点
// ============================================================================

import { useEffect, useRef } from 'react';

export interface UseFocusRestoreOptions {
  /** 是否启用焦点恢复 */
  enabled?: boolean;
  /** 恢复焦点时是否滚动到元素 */
  preventScroll?: boolean;
}

/**
 * 焦点恢复 Hook
 * 在组件挂载时保存当前焦点元素，卸载时恢复焦点
 */
export function useFocusRestore(options: UseFocusRestoreOptions = {}): void {
  const { enabled = true, preventScroll = false } = options;
  const previousActiveElement = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!enabled) return;

    // 保存当前焦点元素
    previousActiveElement.current = document.activeElement as HTMLElement;

    return () => {
      // 恢复焦点
      if (previousActiveElement.current && previousActiveElement.current.focus) {
        try {
          previousActiveElement.current.focus({ preventScroll });
        } catch {
          // 忽略聚焦失败（元素可能已被移除）
        }
      }
    };
  }, [enabled, preventScroll]);
}

export default useFocusRestore;
