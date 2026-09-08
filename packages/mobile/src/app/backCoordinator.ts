import type { PlatformPorts } from '../platform/ports';

export type BackOutcome = 'selection-cleared' | 'keyboard-hidden' | 'layer-dismissed' | 'left-app';

export interface BackCoordinatorDeps {
  ports: { keyboard: Pick<PlatformPorts['keyboard'], 'hide'>; lifecycle: Pick<PlatformPorts['lifecycle'], 'leave'> };
  hasSelection(): boolean;
  clearSelection(): void;
  isKeyboardVisible(): boolean;
  dismissLayer(): boolean;
  onNativeError(): void;
}

// Android back priority: selection -> IME -> sheet/drawer -> OS (N-MOBILE-NATIVE MN-02).
// Predictive back: androidx commits the gesture before calling us and never calls us on
// cancel, so cancellation must leave selection, keyboard, route and drafts untouched.
export function createBackCoordinator(deps: BackCoordinatorDeps) {
  const onBack = (): BackOutcome => {
    if (deps.hasSelection()) { deps.clearSelection(); return 'selection-cleared'; }
    if (deps.isKeyboardVisible()) {
      deps.ports.keyboard.hide().catch(deps.onNativeError);
      return 'keyboard-hidden';
    }
    if (deps.dismissLayer()) return 'layer-dismissed';
    deps.ports.lifecycle.leave().catch(deps.onNativeError);
    return 'left-app';
  };
  const onBackCancelled = (): void => { /* deliberately stateless: a cancelled gesture changes nothing */ };
  return { onBack, onBackCancelled };
}
