// ============================================================================
// useRequireAuth - 需要登录才能执行操作的 Hook
// ============================================================================

import { useCallback } from 'react';
import { useAuthStore } from '../stores/authStore';

/**
 * 用于拦截需要登录才能执行的操作
 *
 * 使用示例:
 * ```tsx
 * const { requireAuth } = useRequireAuth();
 *
 * const handleSendMessage = () => {
 *   requireAuth(() => {
 *     // 实际发送消息逻辑
 *     sendMessage(input);
 *   });
 * };
 * ```
 */
export function useRequireAuth() {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const setShowAuthModal = useAuthStore((state) => state.setShowAuthModal);

  /**
   * 包装需要登录的操作
   * - 已登录: 直接执行 action
   * - 未登录: 弹出登录对话框
   */
  const requireAuth = useCallback(
    <T>(action: () => T): T | undefined => {
      if (isAuthenticated) {
        return action();
      } else {
        setShowAuthModal(true);
        return undefined;
      }
    },
    [isAuthenticated, setShowAuthModal]
  );

  /**
   * 异步版本的 requireAuth
   */
  const requireAuthAsync = useCallback(
    async <T>(action: () => Promise<T>): Promise<T | undefined> => {
      if (isAuthenticated) {
        return action();
      } else {
        setShowAuthModal(true);
        return undefined;
      }
    },
    [isAuthenticated, setShowAuthModal]
  );

  /**
   * 检查是否已登录，不触发弹窗
   */
  const checkAuth = useCallback((): boolean => {
    return isAuthenticated;
  }, [isAuthenticated]);

  return {
    isAuthenticated,
    requireAuth,
    requireAuthAsync,
    checkAuth,
  };
}
