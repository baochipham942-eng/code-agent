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
            ...(preview.surfaceMode !== undefined ? { surfaceMode: preview.surfaceMode } : {}),
            ...(preview.traceId !== undefined ? { traceId: preview.traceId } : {}),
            ...(preview.sessionId !== undefined ? { sessionId: preview.sessionId } : {}),
            ...(preview.profileId !== undefined ? { profileId: preview.profileId } : {}),
            ...(preview.profileMode !== undefined ? { profileMode: preview.profileMode } : {}),
            ...(preview.artifactDirSummary !== undefined ? { artifactDirSummary: preview.artifactDirSummary } : {}),
            ...(preview.workspaceScopeSummary !== undefined ? { workspaceScopeSummary: preview.workspaceScopeSummary } : {}),
          },
        }
      : {}),
  };
}
