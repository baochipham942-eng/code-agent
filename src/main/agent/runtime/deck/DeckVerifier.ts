/**
 * DeckVerifier — Phase 4 PR-2 step 4.
 *
 * 顶层 L1 入口，类似 src/main/agent/runtime/game/GameVerifier 但 deck 的版本
 * **不让自己 extends ArtifactKindVerifier**：先自闭，PR-4 在 game+deck 都跑
 * 通后再决定顶层接口签名（兑现 audit doc §6 Phase 4 「2+ kind 跑通才抽顶层」）。
 *
 * 职责：
 * - 接受 DeckArtifactInput + 可选 subtype（默认 'general'）
 * - 从 registry 查 SubtypeChecker
 * - 找不到 → 返回 passed=false 的 result（保留 failure 信息给上游）
 * - 找到 → 委派 checker.validate(deck)
 *
 * 故意不引入 throw — verifier 应当是纯产物，error 进 result.failures。
 * 这跟 game/GameVerifier 的非破坏性约定一致。
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
