import type { ConfigService } from '../services/core/configService';
import {
  getUpdateService,
  initUpdateService,
  isUpdateServiceInitialized,
  type DownloadProgress,
  type UpdateService,
} from '../services/cloud/updateService';
import { createLogger } from '../services/infra/logger';
import { UPDATE, getCloudApiUrl } from '../../shared/constants';

const logger = createLogger('Bootstrap:UpdateService');

export type UpdateServiceEvent =
  | { type: 'download_progress'; data: DownloadProgress }
  | { type: 'download_complete'; data: { filePath: string } }
  | { type: 'download_error'; data: { error: string } }
  | { type: 'update_available'; data: Awaited<ReturnType<UpdateService['checkForUpdates']>> };

export type UpdateServiceEventSink = (event: UpdateServiceEvent) => void;

let eventSink: UpdateServiceEventSink | null = null;
let initialCheckScheduled = false;

/**
 * Shared, idempotent UpdateService bootstrap used by both desktop-main and the
 * packaged web host. Call this after ConfigService is ready and before any IPC
 * or renderer/runtime preparation entry point is exposed.
 *
 * A host without an interactive window may omit the event sink. Runtime asset
 * installation and status polling remain available in that mode.
 */
export function ensureUpdateServiceInitialized(
  configService: Pick<ConfigService, 'getSettings'>,
  sink?: UpdateServiceEventSink,
): UpdateService {
  if (sink) eventSink = sink;

  const settings = configService.getSettings();
  const updateServerUrl = settings.cloudApi?.url || getCloudApiUrl();
  const updateService = isUpdateServiceInitialized()
    ? getUpdateService()
    : initUpdateService({
      updateServerUrl,
      checkInterval: UPDATE.CLOUD_CHECK_INTERVAL,
      autoDownload: false,
    });

  updateService.setProgressCallback((progress) => {
    eventSink?.({ type: 'download_progress', data: progress });
  });
  updateService.setCompleteCallback((filePath) => {
    eventSink?.({ type: 'download_complete', data: { filePath } });
  });
  updateService.setErrorCallback((error) => {
    eventSink?.({ type: 'download_error', data: { error: error.message } });
  });

  if (!initialCheckScheduled) {
    initialCheckScheduled = true;
    setTimeout(() => {
      updateService.checkForUpdates().then((info) => {
        if (info.hasUpdate) eventSink?.({ type: 'update_available', data: info });
      }).catch((error) => {
        logger.error('Update check failed', error);
      });
    }, UPDATE.INITIAL_CHECK_DELAY);
  }

  logger.info('Update service initialized', { server: updateServerUrl });
  return updateService;
}
