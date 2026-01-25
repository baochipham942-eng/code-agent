// ============================================================================
// Lifecycle Manager - 服务生命周期管理
// ============================================================================
//
// 管理服务的启动和关闭顺序，支持：
// - 分阶段启动：核心服务 → 后台服务
// - 优雅关闭：按依赖逆序关闭
// - 健康检查：检测服务状态
// - 错误恢复：单个服务失败不影响其他服务

import { Container, ServiceToken, Lifecycle, type Disposable, type Initializable } from './container';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('Lifecycle');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * 服务阶段
 */
export enum ServicePhase {
  /** 核心服务：必须在窗口创建前完成，阻塞启动 */
  Core = 'core',
  /** 后台服务：窗口创建后异步初始化，不阻塞启动 */
  Background = 'background',
  /** 延迟服务：按需初始化 */
  Lazy = 'lazy',
}

/**
 * 服务状态
 */
export enum ServiceStatus {
  Pending = 'pending',
  Initializing = 'initializing',
  Ready = 'ready',
  Failed = 'failed',
  Disposing = 'disposing',
  Disposed = 'disposed',
}

/**
 * 服务定义
 */
export interface ServiceDefinition<T = unknown> {
  token: ServiceToken<T>;
  phase: ServicePhase;
  factory: (container: Container) => T | Promise<T>;
  dependencies?: ServiceToken<unknown>[];
  /** 是否在失败时阻止启动（仅对 Core 阶段有效） */
  critical?: boolean;
  /** 初始化超时时间（毫秒） */
  timeout?: number;
}

/**
 * 服务状态信息
 */
export interface ServiceInfo {
  token: ServiceToken<unknown>;
  phase: ServicePhase;
  status: ServiceStatus;
  error?: Error;
  initDuration?: number;
}

/**
 * 生命周期管理器配置
 */
export interface LifecycleConfig {
  /** 默认初始化超时时间（毫秒） */
  defaultTimeout?: number;
  /** 是否启用并行初始化（同一阶段内） */
  parallelInit?: boolean;
}

// ----------------------------------------------------------------------------
// Lifecycle Manager
// ----------------------------------------------------------------------------

/**
 * 服务生命周期管理器
 */
export class LifecycleManager {
  private container: Container;
  private definitions: Map<ServiceToken<unknown>, ServiceDefinition> = new Map();
  private statuses: Map<ServiceToken<unknown>, ServiceInfo> = new Map();
  private config: Required<LifecycleConfig>;
  private isShuttingDown = false;

  constructor(container: Container, config?: LifecycleConfig) {
    this.container = container;
    this.config = {
      defaultTimeout: 30000,
      parallelInit: true,
      ...config,
    };
  }

  // --------------------------------------------------------------------------
  // Service Registration
  // --------------------------------------------------------------------------

  /**
   * 定义服务
   */
  define<T>(definition: ServiceDefinition<T>): this {
    this.definitions.set(definition.token, definition as ServiceDefinition);
    this.statuses.set(definition.token, {
      token: definition.token,
      phase: definition.phase,
      status: ServiceStatus.Pending,
    });

    // 注册到容器
    this.container.registerFactory(
      definition.token,
      definition.factory,
      Lifecycle.Singleton,
      definition.dependencies
    );

    return this;
  }

  // --------------------------------------------------------------------------
  // Startup
  // --------------------------------------------------------------------------

  /**
   * 启动核心服务（阻塞）
   */
  async startCore(): Promise<void> {
    logger.info('Starting core services...');
    const startTime = Date.now();

    const coreServices = this.getServicesByPhase(ServicePhase.Core);
    await this.initializeServices(coreServices);

    logger.info(`Core services started in ${Date.now() - startTime}ms`);
  }

  /**
   * 启动后台服务（非阻塞）
   */
  async startBackground(): Promise<void> {
    logger.info('Starting background services...');
    const startTime = Date.now();

    const backgroundServices = this.getServicesByPhase(ServicePhase.Background);

    // 后台服务失败不抛出异常，只记录日志
    try {
      await this.initializeServices(backgroundServices);
    } catch (error) {
      logger.error('Some background services failed to initialize', error);
    }

    logger.info(`Background services started in ${Date.now() - startTime}ms`);
  }

  /**
   * 按需初始化延迟服务
   */
  async startLazy<T>(token: ServiceToken<T>): Promise<T> {
    const definition = this.definitions.get(token);
    if (!definition) {
      throw new Error(`Service not defined: ${token.name}`);
    }

    if (definition.phase !== ServicePhase.Lazy) {
      throw new Error(`Service ${token.name} is not a lazy service`);
    }

    const info = this.statuses.get(token)!;
    if (info.status === ServiceStatus.Ready) {
      return this.container.resolveSync(token);
    }

    await this.initializeService(definition);
    return this.container.resolveSync(token);
  }

  // --------------------------------------------------------------------------
  // Shutdown
  // --------------------------------------------------------------------------

  /**
   * 优雅关闭所有服务
   */
  async shutdown(): Promise<void> {
    if (this.isShuttingDown) {
      logger.warn('Shutdown already in progress');
      return;
    }

    this.isShuttingDown = true;
    logger.info('Shutting down services...');
    const startTime = Date.now();

    // 按初始化顺序的逆序关闭
    const readyServices = Array.from(this.statuses.values())
      .filter((info) => info.status === ServiceStatus.Ready)
      .reverse();

    for (const info of readyServices) {
      await this.disposeService(info.token);
    }

    // 清理容器
    await this.container.dispose();

    logger.info(`Services shut down in ${Date.now() - startTime}ms`);
  }

  // --------------------------------------------------------------------------
  // Health Check
  // --------------------------------------------------------------------------

  /**
   * 获取所有服务状态
   */
  getStatuses(): ServiceInfo[] {
    return Array.from(this.statuses.values());
  }

  /**
   * 获取服务状态
   */
  getStatus(token: ServiceToken<unknown>): ServiceInfo | undefined {
    return this.statuses.get(token);
  }

  /**
   * 检查所有核心服务是否就绪
   */
  isCoreReady(): boolean {
    const coreServices = this.getServicesByPhase(ServicePhase.Core);
    return coreServices.every((def) => {
      const info = this.statuses.get(def.token);
      return info?.status === ServiceStatus.Ready;
    });
  }

  /**
   * 检查是否有失败的服务
   */
  hasFailures(): boolean {
    return Array.from(this.statuses.values()).some(
      (info) => info.status === ServiceStatus.Failed
    );
  }

  /**
   * 获取失败的服务
   */
  getFailures(): ServiceInfo[] {
    return Array.from(this.statuses.values()).filter(
      (info) => info.status === ServiceStatus.Failed
    );
  }

  // --------------------------------------------------------------------------
  // Private Methods
  // --------------------------------------------------------------------------

  private getServicesByPhase(phase: ServicePhase): ServiceDefinition[] {
    return Array.from(this.definitions.values()).filter((def) => def.phase === phase);
  }

  private async initializeServices(definitions: ServiceDefinition[]): Promise<void> {
    // 按依赖排序
    const sorted = this.topologicalSort(definitions);

    if (this.config.parallelInit) {
      // 分层并行初始化
      const layers = this.groupByDependencyLayer(sorted);
      for (const layer of layers) {
        await Promise.all(layer.map((def) => this.initializeService(def)));
      }
    } else {
      // 串行初始化
      for (const def of sorted) {
        await this.initializeService(def);
      }
    }
  }

  private async initializeService(definition: ServiceDefinition): Promise<void> {
    const info = this.statuses.get(definition.token)!;

    if (info.status === ServiceStatus.Ready) {
      return;
    }

    info.status = ServiceStatus.Initializing;
    const startTime = Date.now();

    try {
      // 先确保依赖已初始化
      if (definition.dependencies) {
        for (const dep of definition.dependencies) {
          await this.container.resolve(dep);
        }
      }

      // 初始化服务
      await this.container.resolve(definition.token);

      info.status = ServiceStatus.Ready;
      info.initDuration = Date.now() - startTime;
      logger.info(`Service initialized: ${definition.token.name} (${info.initDuration}ms)`);
    } catch (error) {
      info.status = ServiceStatus.Failed;
      info.error = error instanceof Error ? error : new Error(String(error));
      info.initDuration = Date.now() - startTime;

      logger.error(`Service failed to initialize: ${definition.token.name}`, error);

      // 核心关键服务失败时抛出异常
      if (definition.phase === ServicePhase.Core && definition.critical !== false) {
        throw error;
      }
    }
  }

  private async disposeService(token: ServiceToken<unknown>): Promise<void> {
    const info = this.statuses.get(token);
    if (!info || info.status === ServiceStatus.Disposed) {
      return;
    }

    info.status = ServiceStatus.Disposing;

    try {
      const instance = this.container.resolveSync(token);
      if (this.isDisposable(instance)) {
        await instance.dispose();
      }
      info.status = ServiceStatus.Disposed;
      logger.debug(`Service disposed: ${token.name}`);
    } catch (error) {
      logger.error(`Failed to dispose service: ${token.name}`, error);
      info.status = ServiceStatus.Disposed; // 标记为已处理，避免重复
    }
  }

  private isDisposable(instance: unknown): instance is Disposable {
    return (
      instance !== null &&
      typeof instance === 'object' &&
      'dispose' in instance &&
      typeof (instance as Disposable).dispose === 'function'
    );
  }

  /**
   * 拓扑排序：确保依赖先于被依赖者初始化
   */
  private topologicalSort(definitions: ServiceDefinition[]): ServiceDefinition[] {
    const result: ServiceDefinition[] = [];
    const visited = new Set<ServiceToken<unknown>>();
    const visiting = new Set<ServiceToken<unknown>>();

    const visit = (def: ServiceDefinition) => {
      if (visited.has(def.token)) return;
      if (visiting.has(def.token)) {
        throw new Error(`Circular dependency detected: ${def.token.name}`);
      }

      visiting.add(def.token);

      // 先访问依赖
      if (def.dependencies) {
        for (const depToken of def.dependencies) {
          const depDef = this.definitions.get(depToken);
          if (depDef) {
            visit(depDef);
          }
        }
      }

      visiting.delete(def.token);
      visited.add(def.token);
      result.push(def);
    };

    for (const def of definitions) {
      visit(def);
    }

    return result;
  }

  /**
   * 按依赖层级分组：同一层的服务可以并行初始化
   */
  private groupByDependencyLayer(definitions: ServiceDefinition[]): ServiceDefinition[][] {
    const layers: ServiceDefinition[][] = [];
    const placed = new Set<ServiceToken<unknown>>();

    while (placed.size < definitions.length) {
      const currentLayer: ServiceDefinition[] = [];

      for (const def of definitions) {
        if (placed.has(def.token)) continue;

        // 检查所有依赖是否已放置
        const depsPlaced = !def.dependencies || def.dependencies.every((dep) => placed.has(dep));
        if (depsPlaced) {
          currentLayer.push(def);
        }
      }

      if (currentLayer.length === 0 && placed.size < definitions.length) {
        // 存在无法解析的依赖
        const remaining = definitions.filter((d) => !placed.has(d.token));
        throw new Error(
          `Cannot resolve dependencies for: ${remaining.map((d) => d.token.name).join(', ')}`
        );
      }

      for (const def of currentLayer) {
        placed.add(def.token);
      }

      if (currentLayer.length > 0) {
        layers.push(currentLayer);
      }
    }

    return layers;
  }
}

// ----------------------------------------------------------------------------
// Global Lifecycle Manager
// ----------------------------------------------------------------------------

let globalLifecycle: LifecycleManager | null = null;

/**
 * 获取全局生命周期管理器
 */
export function getLifecycle(): LifecycleManager | null {
  return globalLifecycle;
}

/**
 * 设置全局生命周期管理器
 */
export function setLifecycle(lifecycle: LifecycleManager | null): void {
  globalLifecycle = lifecycle;
}
