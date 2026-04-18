import type {
  BrowserSessionIntentSnapshot,
  BrowserSessionMode,
} from '@shared/contract/conversationEnvelope';
import type { BrowserWorkbenchState } from '../hooks/useWorkbenchBrowserSession';

export function buildBrowserSessionIntentSnapshot(args: {
  mode: Exclude<BrowserSessionMode, 'none'>;
  browserSession: Pick<
  BrowserWorkbenchState,
  'preview' | 'blocked' | 'blockedDetail' | 'blockedHint'
  >;
}): BrowserSessionIntentSnapshot {
  const { browserSession, mode } = args;
  const preview = browserSession.preview?.mode === mode
    ? browserSession.preview
    : null;

  return {
    ready: !browserSession.blocked,
    ...(browserSession.blockedDetail ? { blockedDetail: browserSession.blockedDetail } : {}),
    ...(browserSession.blockedHint ? { blockedHint: browserSession.blockedHint } : {}),
    ...(preview
      ? {
          preview: {
            ...(preview.title !== undefined ? { title: preview.title } : {}),
            ...(preview.url !== undefined ? { url: preview.url } : {}),
            ...(preview.frontmostApp !== undefined ? { frontmostApp: preview.frontmostApp } : {}),
            ...(preview.lastScreenshotAtMs !== undefined ? { lastScreenshotAtMs: preview.lastScreenshotAtMs } : {}),
          },
        }
      : {}),
  };
}
