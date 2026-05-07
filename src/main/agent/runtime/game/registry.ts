/**
 * Game subtype registry — subtype 注册中心。
 *
 * gameArtifactValidator 在 dispatch 时查这个 registry 拿对应 subtype 的 checker；
 * 不存在时返回 undefined，调用方负责打 warn 然后跳过 subtype-specific 验证
 * （走通用 verb-only 路径）。
 *
 * 单例导出 `gameSubtypeRegistry` — 应用启动时各 subtype 自注册（task C 里 platformer 干这事）。
 */

import type { GameSubtypeChecker } from './types';

class GameSubtypeRegistry {
  private readonly checkers = new Map<string, GameSubtypeChecker>();

  /**
   * 注册一个 subtype checker — 同名重复注册会覆盖（带 warn）。
   * 覆盖语义是为了支持 hot-reload / 测试时替换实现。
   */
  register(checker: GameSubtypeChecker): void {
    if (this.checkers.has(checker.subtype)) {
       
      console.warn(
        `[gameSubtypeRegistry] subtype "${checker.subtype}" already registered, overwriting`,
      );
    }
    this.checkers.set(checker.subtype, checker);
  }

  /** O(1) lookup；找不到返回 undefined，调用方决定怎么 fallback */
  get(subtype: string): GameSubtypeChecker | undefined {
    return this.checkers.get(subtype);
  }

  /** 已注册的 subtype 列表 — 调试/诊断用 */
  list(): string[] {
    return [...this.checkers.keys()].sort();
  }

  /** 清空 — 仅测试场景使用 */
  clear(): void {
    this.checkers.clear();
  }
}

/** 单例 — 整个进程共享 */
export const gameSubtypeRegistry = new GameSubtypeRegistry();

/** 类型导出 — 给测试 / 高级用户单独构造 registry 用 */
export type { GameSubtypeRegistry };
