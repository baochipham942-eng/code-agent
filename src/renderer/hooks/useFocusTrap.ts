// ============================================================================
// useFocusTrap - 焦点陷阱 Hook
// 在模态框等组件中限制焦点循环
// ============================================================================

import { useEffect, useRef, useCallback } from 'react';

// 可聚焦元素选择器
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(', ');

export interface UseFocusTrapOptions {
  /** 是否启用焦点陷阱 */
  enabled?: boolean;
  /** 初始聚焦元素选择器 */
  initialFocus?: string;
  /** 关闭时是否恢复焦点 */
  restoreFocus?: boolean;
  /** 按 Escape 时的回调 */
  onEscape?: () => void;
}

export interface UseFocusTrapReturn {
  /** 绑定到容器元素的 ref */
  containerRef: React.RefObject<HTMLDivElement>;
  /** 手动激活焦点陷阱 */
  activate: () => void;
  /** 手动停用焦点陷阱 */
  deactivate: () => void;
}

export function useFocusTrap(options: UseFocusTrapOptions = {}): UseFocusTrapReturn {
  const {
    enabled = true,
    initialFocus,
    restoreFocus = true,
    onEscape,
  } = options;

  const containerRef = useRef<HTMLDivElement>(null);
  const previousActiveElement = useRef<HTMLElement | null>(null);

  // 获取容器内所有可聚焦元素
  const getFocusableElements = useCallback(() => {
    if (!containerRef.current) return [];
    return Array.from(
      containerRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
    ).filter(el => el.offsetParent !== null); // 排除隐藏元素
  }, []);

  // 激活焦点陷阱
  const activate = useCallback(() => {
    if (!containerRef.current || !enabled) return;

    // 保存当前焦点元素
    previousActiveElement.current = document.activeElement as HTMLElement;

    // 聚焦初始元素或第一个可聚焦元素
    const focusableElements = getFocusableElements();
    if (focusableElements.length === 0) return;

    if (initialFocus) {
      const initialElement = containerRef.current.querySelector<HTMLElement>(initialFocus);
      if (initialElement) {
        initialElement.focus();
        return;
      }
    }

    focusableElements[0]?.focus();
  }, [enabled, initialFocus, getFocusableElements]);

  // 停用焦点陷阱
  const deactivate = useCallback(() => {
    if (restoreFocus && previousActiveElement.current) {
      previousActiveElement.current.focus();
      previousActiveElement.current = null;
    }
  }, [restoreFocus]);

  // 处理 Tab 键循环
  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    if (!containerRef.current || !enabled) return;

    // Escape 键处理
    if (event.key === 'Escape' && onEscape) {
      event.preventDefault();
      onEscape();
      return;
    }

    // Tab 键处理
    if (event.key !== 'Tab') return;

    const focusableElements = getFocusableElements();
    if (focusableElements.length === 0) return;

    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];
    const activeElement = document.activeElement as HTMLElement;

    // Shift+Tab: 从第一个元素循环到最后一个
    if (event.shiftKey && activeElement === firstElement) {
      event.preventDefault();
      lastElement.focus();
      return;
    }

    // Tab: 从最后一个元素循环到第一个
    if (!event.shiftKey && activeElement === lastElement) {
      event.preventDefault();
      firstElement.focus();
      return;
    }
  }, [enabled, getFocusableElements, onEscape]);

  // 阻止焦点逃逸
  const handleFocusIn = useCallback((event: FocusEvent) => {
    if (!containerRef.current || !enabled) return;

    const target = event.target as HTMLElement;

    // 如果焦点移到容器外，将其拉回
    if (!containerRef.current.contains(target)) {
      event.preventDefault();
      const focusableElements = getFocusableElements();
      if (focusableElements.length > 0) {
        focusableElements[0].focus();
      }
    }
  }, [enabled, getFocusableElements]);

  // 设置事件监听
  useEffect(() => {
    if (!enabled) return;

    // 激活焦点陷阱
    activate();

    // 添加事件监听
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('focusin', handleFocusIn);

    return () => {
      // 停用焦点陷阱
      deactivate();

      // 移除事件监听
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('focusin', handleFocusIn);
    };
  }, [enabled, activate, deactivate, handleKeyDown, handleFocusIn]);

  return {
    containerRef,
    activate,
    deactivate,
  };
}

export default useFocusTrap;
