// ============================================================================
// DI Container - 依赖注入容器
// ============================================================================
//
// 轻量级依赖注入容器，支持：
// - 单例 (Singleton): 整个应用生命周期只创建一个实例
// - 工厂 (Factory): 每次解析时创建新实例
// - 瞬态 (Transient): 同工厂，但不缓存
// - 异步初始化: 服务可实现 Initializable 接口
// - 优雅关闭: 服务可实现 Disposable 接口
//
// 使用示例：
// ```typescript
// const container = new Container();
// container.register(SERVICE_TOKENS.ConfigService, ConfigService, Lifecycle.Singleton);
// const configService = await container.resolve<ConfigService>(SERVICE_TOKENS.ConfigService);
// ```

import { createLogger } from '../services/infra/logger';

const logger = createLogger('Container');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * 服务生命周期
 */
export enum Lifecycle {
  /** 单例：整个应用生命周期只创建一个实例 */
  Singleton = 'singleton',
  /** 工厂：每次解析时创建新实例 */
  Factory = 'factory',
  /** 瞬态：同工厂，语义上表示短生命周期 */
  Transient = 'transient',
}

/**
 * 可初始化接口
 * 服务实现此接口可在创建后执行异步初始化
 */
export interface Initializable {
  initialize(): Promise<void>;
}

/**
 * 可销毁接口
 * 服务实现此接口可在容器销毁时执行清理
 */
export interface Disposable {
  dispose(): Promise<void>;
}

/**
 * 服务令牌 - 用于类型安全的服务标识
 */
export class ServiceToken<T> {
  constructor(public readonly name: string) {}
  // 这个属性只用于类型推断，不会实际使用
  readonly _type!: T;
}

/**
 * 创建服务令牌的辅助函数
 */
export function createToken<T>(name: string): ServiceToken<T> {
  return new ServiceToken<T>(name);
}

/**
 * 服务注册信息
 */
interface ServiceRegistration<T = unknown> {
  token: ServiceToken<T>;
  lifecycle: Lifecycle;
  factory: () => T | Promise<T>;
  dependencies?: ServiceToken<unknown>[];
  instance?: T;
  initialized?: boolean;
}

/**
 * 容器配置
 */
export interface ContainerConfig {
  /** 是否在解析时自动初始化服务 */
  autoInitialize?: boolean;
  /** 初始化超时时间（毫秒） */
  initializeTimeout?: number;
}

// ----------------------------------------------------------------------------
// Container Implementation
// ----------------------------------------------------------------------------

/**
 * 依赖注入容器
 */
export class Container {
  private registrations = new Map<ServiceToken<unknown>, ServiceRegistration>();
  private resolving = new Set<ServiceToken<unknown>>();
  private initOrder: ServiceToken<unknown>[] = [];
  private config: Required<ContainerConfig>;

  constructor(config?: ContainerConfig) {
    this.config = {
      autoInitialize: true,
      initializeTimeout: 30000,
      ...config,
    };
  }

  // --------------------------------------------------------------------------
  // Registration
  // --------------------------------------------------------------------------

  /**
   * 注册服务类
   * @param token 服务令牌
   * @param ctor 服务构造函数
   * @param lifecycle 生命周期
   * @param dependencies 依赖的其他服务令牌
   */
  register<T>(
    token: ServiceToken<T>,
    ctor: new (...args: unknown[]) => T,
    lifecycle: Lifecycle = Lifecycle.Singleton,
    dependencies?: ServiceToken<unknown>[]
  ): this {
    this.registrations.set(token, {
      token,
      lifecycle,
      factory: () => {
        const deps = dependencies?.map((dep) => this.resolveSync(dep)) ?? [];
        return new ctor(...deps);
      },
      dependencies,
    });
    return this;
  }

  /**
   * 注册服务工厂函数
   * @param token 服务令牌
   * @param factory 工厂函数
   * @param lifecycle 生命周期
   * @param dependencies 依赖的其他服务令牌
   */
  registerFactory<T>(
    token: ServiceToken<T>,
    factory: (container: Container) => T | Promise<T>,
    lifecycle: Lifecycle = Lifecycle.Singleton,
    dependencies?: ServiceToken<unknown>[]
  ): this {
    this.registrations.set(token, {
      token,
      lifecycle,
      factory: () => factory(this),
      dependencies,
    });
    return this;
  }

  /**
   * 注册已存在的实例
   * @param token 服务令牌
   * @param instance 服务实例
   */
  registerInstance<T>(token: ServiceToken<T>, instance: T): this {
    this.registrations.set(token, {
      token,
      lifecycle: Lifecycle.Singleton,
      factory: () => instance,
      instance,
      initialized: true,
    });
    return this;
  }

  // --------------------------------------------------------------------------
  // Resolution
  // --------------------------------------------------------------------------

  /**
   * 异步解析服务
   * @param token 服务令牌
   * @returns 服务实例
   */
  async resolve<T>(token: ServiceToken<T>): Promise<T> {
    const registration = this.registrations.get(token) as ServiceRegistration<T> | undefined;

    if (!registration) {
      throw new Error(`Service not registered: ${token.name}`);
    }

    // 检测循环依赖
    if (this.resolving.has(token)) {
      throw new Error(`Circular dependency detected: ${token.name}`);
    }

    // 单例已存在，直接返回
    if (registration.lifecycle === Lifecycle.Singleton && registration.instance !== undefined) {
      return registration.instance;
    }

    this.resolving.add(token);

    try {
      // 先解析依赖
      if (registration.dependencies) {
        for (const dep of registration.dependencies) {
          await this.resolve(dep);
        }
      }

      // 创建实例
      let instance = await registration.factory();

      // 自动初始化
      if (this.config.autoInitialize && this.isInitializable(instance)) {
        await this.initializeWithTimeout(instance, token.name);
      }

      // 缓存单例
      if (registration.lifecycle === Lifecycle.Singleton) {
        registration.instance = instance;
        registration.initialized = true;
        this.initOrder.push(token);
      }

      return instance;
    } finally {
      this.resolving.delete(token);
    }
  }

  /**
   * 同步解析服务（仅用于已初始化的单例）
   * @param token 服务令牌
   * @returns 服务实例
   */
  resolveSync<T>(token: ServiceToken<T>): T {
    const registration = this.registrations.get(token) as ServiceRegistration<T> | undefined;

    if (!registration) {
      throw new Error(`Service not registered: ${token.name}`);
    }

    if (registration.lifecycle === Lifecycle.Singleton && registration.instance !== undefined) {
      return registration.instance;
    }

    // 对于非单例或未初始化的单例，同步创建
    const result = registration.factory();
    if (result instanceof Promise) {
      throw new Error(`Cannot synchronously resolve async factory: ${token.name}`);
    }

    if (registration.lifecycle === Lifecycle.Singleton) {
      registration.instance = result;
    }

    return result;
  }

  /**
   * 尝试解析服务，如果不存在返回 undefined
   * @param token 服务令牌
   */
  async tryResolve<T>(token: ServiceToken<T>): Promise<T | undefined> {
    if (!this.registrations.has(token)) {
      return undefined;
    }
    return this.resolve(token);
  }

  /**
   * 检查服务是否已注册
   * @param token 服务令牌
   */
  has(token: ServiceToken<unknown>): boolean {
    return this.registrations.has(token);
  }

  /**
   * 检查服务是否已初始化
   * @param token 服务令牌
   */
  isInitialized(token: ServiceToken<unknown>): boolean {
    const registration = this.registrations.get(token);
    return registration?.initialized ?? false;
  }

  // --------------------------------------------------------------------------
  // Lifecycle Management
  // --------------------------------------------------------------------------

  /**
   * 初始化所有已注册的单例服务
   */
  async initializeAll(): Promise<void> {
    for (const [token] of this.registrations) {
      const registration = this.registrations.get(token);
      if (registration?.lifecycle === Lifecycle.Singleton && !registration.initialized) {
        await this.resolve(token as ServiceToken<unknown>);
      }
    }
  }

  /**
   * 销毁所有服务（按初始化的逆序）
   */
  async dispose(): Promise<void> {
    // 按初始化顺序的逆序销毁
    const tokens = [...this.initOrder].reverse();

    for (const token of tokens) {
      const registration = this.registrations.get(token);
      if (registration?.instance && this.isDisposable(registration.instance)) {
        try {
          logger.debug(`Disposing service: ${token.name}`);
          await registration.instance.dispose();
        } catch (error) {
          logger.error(`Failed to dispose service: ${token.name}`, error);
        }
      }
    }

    // 清理状态
    this.registrations.clear();
    this.initOrder = [];
  }

  /**
   * 获取所有已注册的服务令牌
   */
  getRegisteredTokens(): ServiceToken<unknown>[] {
    return Array.from(this.registrations.keys());
  }

  // --------------------------------------------------------------------------
  // Private Helpers
  // --------------------------------------------------------------------------

  private isInitializable(instance: unknown): instance is Initializable {
    return (
      instance !== null &&
      typeof instance === 'object' &&
      'initialize' in instance &&
      typeof (instance as Initializable).initialize === 'function'
    );
  }

  private isDisposable(instance: unknown): instance is Disposable {
    return (
      instance !== null &&
      typeof instance === 'object' &&
      'dispose' in instance &&
      typeof (instance as Disposable).dispose === 'function'
    );
  }

  private async initializeWithTimeout(instance: Initializable, name: string): Promise<void> {
    const timeout = this.config.initializeTimeout;

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Service initialization timeout: ${name} (${timeout}ms)`));
      }, timeout);
    });

    try {
      await Promise.race([instance.initialize(), timeoutPromise]);
    } catch (error) {
      logger.error(`Failed to initialize service: ${name}`, error);
      throw error;
    }
  }
}

// ----------------------------------------------------------------------------
// Global Container Instance
// ----------------------------------------------------------------------------

let globalContainer: Container | null = null;

/**
 * 获取全局容器实例
 */
export function getContainer(): Container {
  if (!globalContainer) {
    globalContainer = new Container();
  }
  return globalContainer;
}

/**
 * 设置全局容器实例（用于测试）
 */
export function setContainer(container: Container | null): void {
  globalContainer = container;
}

/**
 * 重置全局容器（用于测试）
 */
export async function resetContainer(): Promise<void> {
  if (globalContainer) {
    await globalContainer.dispose();
    globalContainer = null;
  }
}
