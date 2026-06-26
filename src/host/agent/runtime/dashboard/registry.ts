/**
 * Dashboard subtype registry — Phase 4 Dashboard PR-B step 4.
 *
 * 镜像 src/main/agent/runtime/deck/registry 的注册中心模式。
 * PR-B 只占位 'general' 一个 subtype；future subtypes（data-viz / form-app /
 * admin-panel）通过 createDefaultRegistry().set('xxx', ...) 在外部 wire 时
 * 按需注册。
 */

import type { DashboardSubtypeChecker } from './types';
import { GeneralDashboardChecker } from './general/GeneralDashboardChecker';

export type DashboardSubtypeRegistry = Map<string, DashboardSubtypeChecker>;

/**
 * 默认注册表 — 仅含 'general'。
 * 调用方按需 .set() 追加更多 subtype。
 */
export function createDefaultRegistry(): DashboardSubtypeRegistry {
  const registry: DashboardSubtypeRegistry = new Map();
  registry.set('general', new GeneralDashboardChecker());
  return registry;
}
