// ============================================================================
// Activity Provider Registry
// Unifies automatic screen memory and manual desktop activity provider status.
// ============================================================================

import type {
  ActivityProviderDescriptor,
  ActivityProviderListResult,
  ActivityProviderState,
} from '@shared/contract/activityProvider';
import type { OpenchronicleStatus } from '@shared/contract/openchronicle';
import { getStatus as getOpenchronicleStatus } from '../external/openchronicleSupervisor';
import { getNativeDesktopService } from '../desktop/nativeDesktopService';
import { getAudioCaptureStatus } from '../desktop/desktopAudioCapture';

function normalizeOpenchronicleState(state?: ActivityProviderState): ActivityProviderState {
  return state || 'stopped';
}

export async function listActivityProviders(): Promise<ActivityProviderListResult> {
  const generatedAtMs = Date.now();

  const openchronicle: OpenchronicleStatus = await getOpenchronicleStatus().catch((error) => ({
    state: 'error',
    mcpHealthy: false,
    bufferFiles: 0,
    memoryEntries: 0,
    lastError: error instanceof Error ? error.message : String(error),
  }));

  const desktopService = getNativeDesktopService();
  const desktopStatus = desktopService.getStatus();
  const desktopStats = desktopService.getStats({ limit: 200 });
  const audioStatus = getAudioCaptureStatus();
  const nativeDesktopRunning = desktopStatus.running || audioStatus.capturing;
  const nativeDesktopState: ActivityProviderState = desktopStatus.lastError
    ? 'error'
    : nativeDesktopRunning
      ? 'running'
      : 'available';

  const providers: ActivityProviderDescriptor[] = [
    {
      id: 'openchronicle',
      label: 'OpenChronicle',
      kind: 'daemon',
      state: normalizeOpenchronicleState(openchronicle.state),
      captureSources: ['automatic-screen-memory'],
      lifecycle: 'always-on',
      contextRole: 'automatic-background',
      privacyBoundary: 'injection-filtered',
      summary: '长期后台屏幕记忆，负责跨 app 的默认上下文感知。',
      detail: '外部 daemon 独立运行，code-agent 在注入 agent prompt 前做黑名单过滤。',
      lastError: openchronicle.lastError || null,
      metadata: {
        pid: openchronicle.pid || null,
        mcpHealthy: openchronicle.mcpHealthy || false,
        bufferFiles: openchronicle.bufferFiles || 0,
        memoryEntries: openchronicle.memoryEntries || 0,
      },
    },
    {
      id: 'tauri-native-desktop',
      label: 'Tauri Native Desktop',
      kind: 'bundled',
      state: nativeDesktopState,
      captureSources: ['manual-desktop-session', 'meeting-audio', 'screenshot-analysis'],
      lifecycle: 'app-scoped',
      contextRole: 'manual-scene-capture',
      privacyBoundary: 'provider-filtered',
      summary: '内置在 Tauri app 里的手动桌面活动 provider，用于临时采集、会议音频和截图分析。',
      detail: '权限主体跟随 Tauri app，采集核心留在 bundled provider，音频和分析后续可以拆成 sidecar worker。',
      lastActivityAtMs: desktopStatus.lastEventAtMs || desktopStats.lastEventAtMs || null,
      lastError: desktopStatus.lastError || null,
      metadata: {
        collectorRunning: desktopStatus.running,
        audioCapturing: audioStatus.capturing,
        audioCaptureMode: audioStatus.captureMode,
        totalEventsWritten: desktopStatus.totalEventsWritten,
        totalRecentEvents: desktopStats.totalEvents,
        uniqueApps: desktopStats.uniqueApps,
        screenshotDir: desktopStatus.screenshotDir || null,
        sqliteDbPath: desktopStatus.sqliteDbPath || null,
      },
    },
  ];

  return { generatedAtMs, providers };
}
