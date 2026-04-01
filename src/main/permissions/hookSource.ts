// ============================================================================
// Hook Guard Source
// ============================================================================
//
// Placeholder GuardSource that will integrate with HookManager in future.
// Currently returns null (no verdict) when no hooks are configured.
// ============================================================================

import type { GuardSource, GuardRequest, GuardSourceResult } from './guardFabric';

export class HookGuardSource implements GuardSource {
  name = 'hooks';

  evaluate(_request: GuardRequest): GuardSourceResult | null {
    // Placeholder: returns null when no hooks configured.
    // Full implementation requires HookManager integration (future).
    return null;
  }
}
