/**
 * DeckVerifier — Phase 4 PR-2 step 4.
 *
 * Deck artifact 顶层入口。Game 那边走的是 validateGameArtifact 自由函数，
 * deck 这边走类 + subtype dispatch。两边形态分歧到无法共用同一接口，
 * 因此 DeckVerifier 不 extends 任何跨 kind 顶层接口（详见
 * docs/decisions/016-no-cross-kind-verifier-interface.md）。
 *
 * 职责：
 * - 接受 DeckArtifactInput + 可选 subtype（默认 'general'）
 * - 从 registry 查 SubtypeChecker
 * - 找不到 → 返回 passed=false 的 result（保留 failure 信息给上游）
 * - 找到 → 委派 checker.validate(deck)
 *
 * 故意不 throw — verifier 应当是纯产物，error 进 result.failures。
 */

import type { DeckArtifactInput, DeckCheckResult } from './types';
import { createDefaultRegistry, type DeckSubtypeRegistry } from './registry';

export class DeckVerifier {
  private readonly registry: DeckSubtypeRegistry;

  constructor(registry?: DeckSubtypeRegistry) {
    this.registry = registry ?? createDefaultRegistry();
  }

  /**
   * 跑指定 subtype 的全部 probe。
   *
   * @param deck    deck artifact 输入
   * @param subtype subtype id（默认 'general'）
   */
  validate(deck: DeckArtifactInput, subtype: string = 'general'): DeckCheckResult {
    const checker = this.registry.get(subtype);
    if (!checker) {
      return {
        passed: false,
        probes: [],
        failures: [`Unknown deck subtype: ${subtype}`],
        subtype,
      };
    }
    return checker.validate(deck);
  }

  /** 暴露已注册的 subtype 列表（调试 / 反射用） */
  listSubtypes(): readonly string[] {
    return Array.from(this.registry.keys());
  }
}
