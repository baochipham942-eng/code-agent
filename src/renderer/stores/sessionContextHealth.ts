import type { ContextHealthState } from '@shared/contract/contextHealth';

export function shouldReplaceContextHealth(
  next: ContextHealthState | null | undefined,
  previous: ContextHealthState | null | undefined,
): boolean {
  if (!previous) {
    return true;
  }
  if (!next) {
    return false;
  }
  if (next.currentTokens > 0) {
    return true;
  }
  return previous.currentTokens <= 0;
}
