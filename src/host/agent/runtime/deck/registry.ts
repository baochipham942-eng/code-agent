/**
 * Deck subtype registry — Phase 4 PR-2 step 4.
 *
 * 镜像 src/host/agent/runtime/game/registry 的注册中心模式。
 * PR-2 只占位 'general' 一个 subtype；future subtypes（executive-deck /
 * academic-paper / data-report）通过 createDefaultRegistry().set('xxx', ...)
 * 或者在外部 wire 时按需注册。
 */

import type { DeckSubtypeChecker } from './types';
import { GeneralDeckChecker } from './general/GeneralDeckChecker';

export type DeckSubtypeRegistry = Map<string, DeckSubtypeChecker>;

/**
 * 默认注册表 — 仅含 'general'。
 * 调用方按需 .set() 追加更多 subtype。
 */
export function createDefaultRegistry(): DeckSubtypeRegistry {
  const registry: DeckSubtypeRegistry = new Map();
  registry.set('general', new GeneralDeckChecker());
  return registry;
}
