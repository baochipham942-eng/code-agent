// 浏览器工具条按钮可用态（二期 N2）：无历史置灰、非本会话禁用。

export interface BrowserToolbarCapabilityInput {
  running: boolean;
  hasUrl: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  ownedByCurrentSession: boolean;
}

export interface BrowserToolbarCapabilityState {
  backEnabled: boolean;
  forwardEnabled: boolean;
  reloadEnabled: boolean;
  openExternalEnabled: boolean;
  annotateEnabled: boolean;
}

export function resolveBrowserToolbarState(
  input: BrowserToolbarCapabilityInput,
): BrowserToolbarCapabilityState {
  const operable = input.ownedByCurrentSession && input.running && input.hasUrl;
  return {
    backEnabled: operable && input.canGoBack,
    forwardEnabled: operable && input.canGoForward,
    reloadEnabled: operable,
    openExternalEnabled: operable,
    annotateEnabled: operable,
  };
}
