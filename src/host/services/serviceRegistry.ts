// ============================================================================
// ServiceRegistry - 轻量服务注册表
// ============================================================================
// 不是 IoC 容器，只解决两个问题：
// 1. 统一关闭机制（graceful shutdown）
// 2. 测试重置（替代散落的 vi.mock()）
// ============================================================================

import { createLogger, logger as defaultLogger } from './infra/logger';

const logger = createLogger('ServiceRegistry');

/**
 * 可释放资源接口
 */
export interface Disposable {
  dispose(): Promise<void>;
}

/**
 * 服务注册条目
 */
interface ServiceEntry {
  name: string;
  instance: Disposable;
  registeredAt: number;
}

/**
 * 轻量服务注册表
 */
class ServiceRegistry {
  private static instance: ServiceRegistry;
  private entries: ServiceEntry[] = [];
  private disposed = false;

  private constructor() {}

  static getInstance(): ServiceRegistry {
    if (!ServiceRegistry.instance) {
      ServiceRegistry.instance = new ServiceRegistry();
    }
    return ServiceRegistry.instance;
  }

  /**
   * 注册可释放的服务
   */
  register(name: string, service: Disposable): void {
    // 避免重复注册
    const existing = this.entries.find(e => e.name === name);
    if (existing) {
      logger.debug(`Service "${name}" already registered, skipping`);
      return;
    }

    this.entries.push({
      name,
      instance: service,
      registeredAt: Date.now(),
    });

    logger.debug(`Service registered: ${name}`);
  }

  /**
   * 按注册逆序释放所有服务
   */
  async disposeAll(): Promise<void> {
    if (this.disposed) {
      logger.debug('Already disposed, skipping');
      return;
    }

    this.disposed = true;
    const reversed = [...this.entries].reverse();

    for (const entry of reversed) {
      try {
        await entry.instance.dispose();
        logger.debug(`Disposed: ${entry.name}`);
      } catch (error) {
        logger.warn(`Failed to dispose "${entry.name}"`, { error });
      }
    }

    this.entries = [];
    logger.info(`All services disposed (${reversed.length} total)`);
  }

  /**
   * 重置所有 singleton（测试用）
   */
  resetAll(): void {
    this.entries = [];
    this.disposed = false;
    logger.debug('All services reset');
  }

  /**
   * 获取已注册服务列表（调试用）
   */
  getRegisteredServices(): string[] {
    return this.entries.map(e => e.name);
  }

  /**
   * 是否已释放
   */
  isDisposed(): boolean {
    return this.disposed;
  }
}

// 导出单例访问
// Logger 由 registry 在首次调用时主动注册（依赖方向：registry → logger 单向）
let loggerRegistered = false;
export function getServiceRegistry(): ServiceRegistry {
  const registry = ServiceRegistry.getInstance();
  if (!loggerRegistered) {
    loggerRegistered = true;
    registry.register('Logger', defaultLogger);
  }
  return registry;
}

/**
 * 测试辅助：重置所有服务和 ServiceRegistry 自身
 */
export function resetAllServices(): void {
  ServiceRegistry.getInstance().resetAll();
}
