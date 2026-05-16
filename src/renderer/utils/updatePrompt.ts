import type { UpdateInfo } from '@shared/contract';

const UPDATE_PROMPT_SEEN_KEY_PREFIX = 'code-agent:updatePromptSeen:';

function getClientVersionKey(currentVersion: string | null | undefined): string {
  const normalized = (currentVersion || 'unknown').trim() || 'unknown';
  return `${UPDATE_PROMPT_SEEN_KEY_PREFIX}${encodeURIComponent(normalized)}`;
}

export function hasSeenUpdatePromptForClientVersion(currentVersion: string | null | undefined): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem(getClientVersionKey(currentVersion)) === '1';
  } catch {
    return false;
  }
}

export function markUpdatePromptSeenForClientVersion(currentVersion: string | null | undefined): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(getClientVersionKey(currentVersion), '1');
  } catch {
    // localStorage 不可用时只降级为本次不持久化，不影响更新页可用。
  }
}

export function shouldShowOptionalUpdatePrompt(updateInfo: UpdateInfo | null | undefined): boolean {
  return Boolean(
    updateInfo?.hasUpdate &&
    !updateInfo.forceUpdate &&
    !hasSeenUpdatePromptForClientVersion(updateInfo.currentVersion),
  );
}
