const DEBUG_DRAFT_PARAM = '__neoDraft';
// FB-430：自动提交已移除（外站链接能借登录态替用户发消息）；旧链接里的参数只清掉、不生效
const LEGACY_SUBMIT_PARAM = '__neoSubmit';

export interface DebugDraftUrlPayload {
  content: string;
}

function isLocalDebugDraftHost(hostname: string): boolean {
  return hostname === '127.0.0.1'
    || hostname === 'localhost'
    || hostname === '::1'
    || hostname === '[::1]';
}

export function readDebugDraftFromLocation(
  location: Pick<Location, 'hostname' | 'search'>,
): DebugDraftUrlPayload | null {
  if (!isLocalDebugDraftHost(location.hostname)) {
    return null;
  }

  const params = new URLSearchParams(location.search);
  const content = params.get(DEBUG_DRAFT_PARAM);
  if (!content) {
    return null;
  }

  return { content };
}

export function clearDebugDraftParamsFromUrl(url: URL): string {
  url.searchParams.delete(DEBUG_DRAFT_PARAM);
  url.searchParams.delete(LEGACY_SUBMIT_PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function clearDebugDraftParamsFromCurrentUrl(win: Window): void {
  const current = new URL(win.location.href);
  const next = clearDebugDraftParamsFromUrl(current);
  win.history.replaceState(win.history.state, '', next);
}
