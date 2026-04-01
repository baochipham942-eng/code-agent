// ============================================================================
// Prompt Profiles - Entry profiles for 5-layer prompt composition
// ============================================================================
// Profiles control which overlay layers are active for each agent entry point.
// ============================================================================

import type { OverlayLayer } from './overlayEngine';

export type PromptProfile = 'interactive' | 'oneshot' | 'subagent' | 'fork';

export interface PromptContext {
  rules?: string[];
  memory?: string[];
  skills?: string[];
  agentFrontmatter?: string;
  parentPrompt?: string;
  forkMessages?: unknown[];
  appendPrompt?: string;
  systemContext?: string;
  userContext?: string;
  mode?: string;
  customSystemPrompt?: string;
}

/**
 * Returns which overlay layers are active for each profile.
 *
 * - interactive: all 5 layers (substrate, mode, memory, append, projection)
 * - oneshot:     only substrate (flatten everything else into it)
 * - subagent:    substrate + mode + memory (skip append, skip projection)
 * - fork:        empty set (inherit parent prompt directly)
 */
export function getProfileOverlays(profile: PromptProfile): Set<OverlayLayer> {
  switch (profile) {
    case 'interactive':
      return new Set<OverlayLayer>(['substrate', 'mode', 'memory', 'append', 'projection']);
    case 'oneshot':
      return new Set<OverlayLayer>(['substrate']);
    case 'subagent':
      return new Set<OverlayLayer>(['substrate', 'mode', 'memory']);
    case 'fork':
      return new Set<OverlayLayer>();
  }
}
