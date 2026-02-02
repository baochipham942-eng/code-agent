// ============================================================================
// NetworkStatus - 网络状态指示器（支持自动重连）
// ============================================================================

import React, { useState, useEffect, useCallback } from 'react';
import { Wifi, WifiOff, RefreshCw, AlertTriangle } from 'lucide-react';
import type { NetworkStatusProps, NetworkStateExtended } from './types';

// ============================================================================
// Legacy Component (保持向后兼容)
// ============================================================================

const STATUS_COLORS = {
  online: 'bg-green-500',
  offline: 'bg-red-500',
  slow: 'bg-yellow-500',
};

const STATUS_TOOLTIPS = {
  online: 'Network: Online',
  offline: 'Network: Offline',
  slow: 'Network: Slow connection',
};

export function NetworkStatus({ status }: NetworkStatusProps) {
  return (
    <span
      className={`w-2 h-2 rounded-full ${STATUS_COLORS[status]}`}
      title={STATUS_TOOLTIPS[status]}
    />
  );
}

// ============================================================================
// Enhanced Network Status (带自动重连)
// ============================================================================

interface NetworkStatusEnhancedProps {
  showLabel?: boolean;
  compact?: boolean;
  className?: string;
  maxReconnectAttempts?: number;
  baseReconnectDelay?: number;
}

export function NetworkStatusEnhanced({
  showLabel = false,
  compact = false,
  className = '',
  maxReconnectAttempts = 10,
  baseReconnectDelay = 1000,
}: NetworkStatusEnhancedProps) {
  const [state, setState] = useState<NetworkStateExtended>({
    status: navigator.onLine ? 'online' : 'offline',
    reconnectAttempts: 0,
    nextReconnectAt: null,
    lastOnlineAt: navigator.onLine ? Date.now() : null,
  });
  const [countdown, setCountdown] = useState<number | null>(null);

  // 检查网络连接
  const checkConnection = useCallback(async (): Promise<boolean> => {
    if (!navigator.onLine) return false;

    try {
      // 尝试 HEAD 请求检测真实连接状态
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      await fetch('https://api.deepseek.com', {
        method: 'HEAD',
        signal: controller.signal,
        mode: 'no-cors',
      });

      clearTimeout(timeoutId);
      return true;
    } catch {
      return navigator.onLine; // 降级到浏览器状态
    }
  }, []);

  // 处理上线事件
  const handleOnline = useCallback(() => {
    setState({
      status: 'online',
      reconnectAttempts: 0,
      nextReconnectAt: null,
      lastOnlineAt: Date.now(),
    });
    setCountdown(null);
  }, []);

  // 处理下线事件
  const handleOffline = useCallback(() => {
    setState(prev => ({
      ...prev,
      status: 'offline',
    }));
  }, []);

  // 尝试重连
  const attemptReconnect = useCallback(async () => {
    if (state.reconnectAttempts >= maxReconnectAttempts) {
      return;
    }

    setState(prev => ({
      ...prev,
      status: 'reconnecting',
      reconnectAttempts: prev.reconnectAttempts + 1,
    }));

    const isOnline = await checkConnection();

    if (isOnline) {
      handleOnline();
    } else {
      // 计算下次重连时间（指数退避）
      const delay = Math.min(
        baseReconnectDelay * Math.pow(2, state.reconnectAttempts),
        30000
      );
      const nextTime = Date.now() + delay;

      setState(prev => ({
        ...prev,
        status: 'offline',
        nextReconnectAt: nextTime,
      }));
    }
  }, [state.reconnectAttempts, maxReconnectAttempts, checkConnection, handleOnline, baseReconnectDelay]);

  // 监听网络状态变化
  useEffect(() => {
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [handleOnline, handleOffline]);

  // 自动重连定时器
  useEffect(() => {
    if (state.status !== 'offline' || !state.nextReconnectAt) return;

    const delay = state.nextReconnectAt - Date.now();
    if (delay <= 0) {
      attemptReconnect();
      return;
    }

    const timer = setTimeout(attemptReconnect, delay);
    return () => clearTimeout(timer);
  }, [state.status, state.nextReconnectAt, attemptReconnect]);

  // 倒计时更新
  useEffect(() => {
    if (!state.nextReconnectAt) {
      setCountdown(null);
      return;
    }

    const updateCountdown = () => {
      const remaining = Math.max(0, state.nextReconnectAt! - Date.now());
      setCountdown(Math.ceil(remaining / 1000));
    };

    updateCountdown();
    const timer = setInterval(updateCountdown, 1000);
    return () => clearInterval(timer);
  }, [state.nextReconnectAt]);

  // 离线时触发首次重连
  useEffect(() => {
    if (state.status === 'offline' && state.reconnectAttempts === 0 && !state.nextReconnectAt) {
      const nextTime = Date.now() + baseReconnectDelay;
      setState(prev => ({ ...prev, nextReconnectAt: nextTime }));
    }
  }, [state.status, state.reconnectAttempts, state.nextReconnectAt, baseReconnectDelay]);

  // 在线且紧凑模式 - 不显示
  if (state.status === 'online' && compact) {
    return null;
  }

  // 在线状态
  if (state.status === 'online') {
    return (
      <div
        className={`flex items-center gap-1.5 text-emerald-400 ${className}`}
        title="网络连接正常"
      >
        <Wifi className="w-3.5 h-3.5" />
        {showLabel && <span className="text-xs">在线</span>}
      </div>
    );
  }

  // 重连中状态
  if (state.status === 'reconnecting') {
    return (
      <div
        className={`flex items-center gap-1.5 text-amber-400 ${className}`}
        title={`正在重连... (尝试 ${state.reconnectAttempts}/${maxReconnectAttempts})`}
      >
        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
        {showLabel && <span className="text-xs">重连中...</span>}
      </div>
    );
  }

  // 离线状态
  const isMaxAttempts = state.reconnectAttempts >= maxReconnectAttempts;
  const isDisabled = state.status !== 'offline';

  return (
    <button
      onClick={attemptReconnect}
      className={`flex items-center gap-1.5 text-red-400 hover:text-red-300 transition-colors ${className}`}
      title={isMaxAttempts ? '连接失败，点击重试' : '网络已断开，点击重试'}
      disabled={isDisabled}
    >
      {isMaxAttempts ? (
        <AlertTriangle className="w-3.5 h-3.5" />
      ) : (
        <WifiOff className="w-3.5 h-3.5" />
      )}
      {showLabel && (
        <span className="text-xs">
          {isMaxAttempts ? '连接失败' : countdown !== null ? `${countdown}s` : '离线'}
        </span>
      )}
    </button>
  );
}

// ============================================================================
// NetworkBanner - 全局网络状态横幅
// ============================================================================

export function NetworkBanner() {
  const [state, setState] = useState<NetworkStateExtended>({
    status: navigator.onLine ? 'online' : 'offline',
    reconnectAttempts: 0,
    nextReconnectAt: null,
    lastOnlineAt: navigator.onLine ? Date.now() : null,
  });

  useEffect(() => {
    const handleOnline = () => {
      setState({
        status: 'online',
        reconnectAttempts: 0,
        nextReconnectAt: null,
        lastOnlineAt: Date.now(),
      });
    };

    const handleOffline = () => {
      setState(prev => ({ ...prev, status: 'offline' }));
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // 在线时不显示
  if (state.status === 'online') {
    return null;
  }

  return (
    <div
      className="fixed top-0 left-0 right-0 z-50 px-4 py-2 text-center text-sm bg-red-500/90 text-white"
      role="alert"
    >
      <div className="flex items-center justify-center gap-2">
        <WifiOff className="w-4 h-4" />
        <span>网络已断开，正在尝试重新连接...</span>
      </div>
    </div>
  );
}
