// ============================================================================
// NetworkMonitor - 网络状态监控和自动重连服务
// 监控网络连接状态，断开时自动重试
// ============================================================================

import { createLogger } from '../utils/logger';

const logger = createLogger('NetworkMonitor');

// ============================================================================
// Types
// ============================================================================

export type NetworkStatus = 'online' | 'offline' | 'reconnecting';

export interface NetworkState {
  status: NetworkStatus;
  /** 上次在线时间 */
  lastOnlineAt: number | null;
  /** 断开时长（毫秒） */
  offlineDuration: number;
  /** 重连尝试次数 */
  reconnectAttempts: number;
  /** 下次重连时间 */
  nextReconnectAt: number | null;
}

export interface NetworkMonitorConfig {
  /** 重连间隔基数（毫秒），默认 1000 */
  baseReconnectDelay: number;
  /** 最大重连间隔（毫秒），默认 30000 */
  maxReconnectDelay: number;
  /** 最大重连次数，默认 10 */
  maxReconnectAttempts: number;
  /** 健康检查端点 */
  healthCheckUrl?: string;
  /** 健康检查间隔（毫秒），默认 30000 */
  healthCheckInterval: number;
}

type StatusChangeCallback = (state: NetworkState) => void;

// ============================================================================
// Default Config
// ============================================================================

const DEFAULT_CONFIG: NetworkMonitorConfig = {
  baseReconnectDelay: 1000,
  maxReconnectDelay: 30000,
  maxReconnectAttempts: 10,
  healthCheckInterval: 30000,
};

// ============================================================================
// NetworkMonitor Class
// ============================================================================

export class NetworkMonitor {
  private config: NetworkMonitorConfig;
  private state: NetworkState;
  private listeners: Set<StatusChangeCallback> = new Set();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private isDestroyed = false;

  constructor(config: Partial<NetworkMonitorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.state = {
      status: navigator.onLine ? 'online' : 'offline',
      lastOnlineAt: navigator.onLine ? Date.now() : null,
      offlineDuration: 0,
      reconnectAttempts: 0,
      nextReconnectAt: null,
    };

    this.setupEventListeners();
    this.startHealthCheck();
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * 获取当前网络状态
   */
  getState(): NetworkState {
    return { ...this.state };
  }

  /**
   * 订阅状态变化
   */
  subscribe(callback: StatusChangeCallback): () => void {
    this.listeners.add(callback);
    // 立即回调当前状态
    callback(this.getState());
    return () => this.listeners.delete(callback);
  }

  /**
   * 手动触发重连检查
   */
  async checkConnection(): Promise<boolean> {
    return this.performHealthCheck();
  }

  /**
   * 重置重连计数
   */
  resetReconnectAttempts(): void {
    this.state.reconnectAttempts = 0;
    this.state.nextReconnectAt = null;
  }

  /**
   * 销毁监控器
   */
  destroy(): void {
    this.isDestroyed = true;
    this.listeners.clear();
    this.clearTimers();
    window.removeEventListener('online', this.handleOnline);
    window.removeEventListener('offline', this.handleOffline);
  }

  // --------------------------------------------------------------------------
  // Private Methods
  // --------------------------------------------------------------------------

  private setupEventListeners(): void {
    window.addEventListener('online', this.handleOnline);
    window.addEventListener('offline', this.handleOffline);
  }

  private handleOnline = (): void => {
    logger.info('Network online event detected');
    this.updateState({
      status: 'online',
      lastOnlineAt: Date.now(),
      offlineDuration: 0,
      reconnectAttempts: 0,
      nextReconnectAt: null,
    });
    this.clearReconnectTimer();
  };

  private handleOffline = (): void => {
    logger.warn('Network offline event detected');
    this.updateState({
      status: 'offline',
      offlineDuration: this.state.lastOnlineAt
        ? Date.now() - this.state.lastOnlineAt
        : 0,
    });
    this.scheduleReconnect();
  };

  private updateState(updates: Partial<NetworkState>): void {
    const prevStatus = this.state.status;
    this.state = { ...this.state, ...updates };

    if (prevStatus !== this.state.status || updates.reconnectAttempts !== undefined) {
      this.notifyListeners();
    }
  }

  private notifyListeners(): void {
    const state = this.getState();
    this.listeners.forEach((callback) => {
      try {
        callback(state);
      } catch (error) {
        logger.error('Error in network status listener', error);
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.isDestroyed) return;

    if (this.state.reconnectAttempts >= this.config.maxReconnectAttempts) {
      logger.warn('Max reconnect attempts reached', {
        attempts: this.state.reconnectAttempts,
      });
      return;
    }

    // 指数退避计算延迟
    const delay = Math.min(
      this.config.baseReconnectDelay * Math.pow(2, this.state.reconnectAttempts),
      this.config.maxReconnectDelay
    );

    const nextReconnectAt = Date.now() + delay;
    this.updateState({
      status: 'reconnecting',
      nextReconnectAt,
    });

    logger.info('Scheduling reconnect', {
      attempt: this.state.reconnectAttempts + 1,
      delay,
    });

    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => this.attemptReconnect(), delay);
  }

  private async attemptReconnect(): Promise<void> {
    if (this.isDestroyed) return;

    this.state.reconnectAttempts++;
    logger.info('Attempting reconnect', { attempt: this.state.reconnectAttempts });

    const isOnline = await this.performHealthCheck();

    if (isOnline) {
      this.handleOnline();
    } else if (this.state.reconnectAttempts < this.config.maxReconnectAttempts) {
      this.scheduleReconnect();
    } else {
      this.updateState({ status: 'offline', nextReconnectAt: null });
    }
  }

  private async performHealthCheck(): Promise<boolean> {
    // 首先检查浏览器报告的在线状态
    if (!navigator.onLine) {
      return false;
    }

    // 如果配置了健康检查端点，进行实际的网络请求
    if (this.config.healthCheckUrl) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        const response = await fetch(this.config.healthCheckUrl, {
          method: 'HEAD',
          signal: controller.signal,
          cache: 'no-store',
        });

        clearTimeout(timeoutId);
        return response.ok;
      } catch {
        return false;
      }
    }

    return navigator.onLine;
  }

  private startHealthCheck(): void {
    if (this.config.healthCheckInterval <= 0) return;

    this.healthCheckTimer = setInterval(async () => {
      if (this.state.status === 'online') {
        const isOnline = await this.performHealthCheck();
        if (!isOnline) {
          this.handleOffline();
        }
      }
    }, this.config.healthCheckInterval);
  }

  private clearTimers(): void {
    this.clearReconnectTimer();
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let networkMonitorInstance: NetworkMonitor | null = null;

export function getNetworkMonitor(config?: Partial<NetworkMonitorConfig>): NetworkMonitor {
  if (!networkMonitorInstance) {
    networkMonitorInstance = new NetworkMonitor(config);
  }
  return networkMonitorInstance;
}

export default NetworkMonitor;
