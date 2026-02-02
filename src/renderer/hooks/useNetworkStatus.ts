// ============================================================================
// useNetworkStatus - 网络状态 Hook
// 提供响应式的网络状态监控
// ============================================================================

import { useState, useEffect, useCallback } from 'react';
import { getNetworkMonitor, type NetworkState, type NetworkMonitorConfig } from '../services/NetworkMonitor';

// ============================================================================
// Types
// ============================================================================

export interface UseNetworkStatusReturn {
  /** 是否在线 */
  isOnline: boolean;
  /** 是否正在重连 */
  isReconnecting: boolean;
  /** 网络状态详情 */
  state: NetworkState;
  /** 手动检查连接 */
  checkConnection: () => Promise<boolean>;
  /** 重置重连计数 */
  resetReconnectAttempts: () => void;
}

// ============================================================================
// Hook
// ============================================================================

export function useNetworkStatus(
  config?: Partial<NetworkMonitorConfig>
): UseNetworkStatusReturn {
  const monitor = getNetworkMonitor(config);
  const [state, setState] = useState<NetworkState>(monitor.getState());

  useEffect(() => {
    const unsubscribe = monitor.subscribe(setState);
    return unsubscribe;
  }, [monitor]);

  const checkConnection = useCallback(async () => {
    return monitor.checkConnection();
  }, [monitor]);

  const resetReconnectAttempts = useCallback(() => {
    monitor.resetReconnectAttempts();
  }, [monitor]);

  return {
    isOnline: state.status === 'online',
    isReconnecting: state.status === 'reconnecting',
    state,
    checkConnection,
    resetReconnectAttempts,
  };
}

export default useNetworkStatus;
