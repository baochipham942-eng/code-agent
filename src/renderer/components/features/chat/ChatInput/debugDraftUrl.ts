export const DEBUG_DRAFT_PARAM = '__neoDraft';
export const DEBUG_DRAFT_SUBMIT_PARAM = '__neoSubmit';

export interface DebugDraftUrlPayload {
  content: string;
  autoSubmit: boolean;
}

export function isLocalDebugDraftHost(hostname: string): boolean {
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

  const submitValue = params.get(DEBUG_DRAFT_SUBMIT_PARAM);
  return {
    content,
    autoSubmit: submitValue === '1' || submitValue === 'true',
  };
}

export function clearDebugDraftParamsFromUrl(url: URL): string {
  url.searchParams.delete(DEBUG_DRAFT_PARAM);
  url.searchParams.delete(DEBUG_DRAFT_SUBMIT_PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function clearDebugDraftParamsFromCurrentUrl(win: Window): void {
  const current = new URL(win.location.href);
  const next = clearDebugDraftParamsFromUrl(current);
  win.history.replaceState(win.history.state, '', next);
}
