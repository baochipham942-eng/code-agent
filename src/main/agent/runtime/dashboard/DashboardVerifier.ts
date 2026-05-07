/**
 * DashboardVerifier — Phase 4 Dashboard PR-B step 4.
 *
 * Dashboard artifact 顶层入口。仿 DeckVerifier 类 + subtype dispatch 模式，但
 * validate 是 **async**：dashboard 的 imperative probe 要 launch Playwright
 * 跑 browser interaction，整条链路必须 async。
 *
 * input 是 filePath（落盘 HTML），不是 in-memory data — Playwright 必须有
 * 文件 URL 才能 launch（详见 plan §3 决策 2）。
 *
 * 跟 game/deck 顶层接口的关系按 ADR 016 不抽象（form mismatch 是接受的）。
 *
 * 故意不 throw — verifier 应当是纯产物，error 进 result.failures。
 */

import type { DashboardArtifactInput, DashboardCheckResult } from './types';
import { createDefaultRegistry, type DashboardSubtypeRegistry } from './registry';

export class DashboardVerifier {
  private readonly registry: DashboardSubtypeRegistry;

  constructor(registry?: DashboardSubtypeRegistry) {
    this.registry = registry ?? createDefaultRegistry();
  }

  /**
   * 跑指定 subtype 的全部 probe。
   *
   * @param input   dashboard artifact 输入（含 filePath）
   * @param subtype subtype id（默认 'general'）
   */
  async validate(
    input: DashboardArtifactInput,
    subtype: string = 'general',
  ): Promise<DashboardCheckResult> {
    const checker = this.registry.get(subtype);
    if (!checker) {
      return {
        passed: false,
        probes: [],
        failures: [`Unknown dashboard subtype: ${subtype}`],
        subtype,
      };
    }
    return checker.validate(input);
  }

  /** 暴露已注册的 subtype 列表（调试 / 反射用） */
  listSubtypes(): readonly string[] {
    return Array.from(this.registry.keys());
  }
}
