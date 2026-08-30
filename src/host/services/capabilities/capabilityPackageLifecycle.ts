import { TurnTraceRecorder } from '../../agent/runtime/turnTrace';
import { recordCapabilityLifecycle } from '../capability/capabilityLifecycleTrace';
import { createLogger } from '../infra/logger';

const logger = createLogger('CapabilityPackageLifecycle');
let trace: TurnTraceRecorder | null = null;

export function recordCapabilityPackageLifecycle(
  pluginId: string,
  action: 'loaded' | 'unloaded' | 'rolled_back' | 'failed',
  detail?: string,
): void {
  try {
    trace ??= new TurnTraceRecorder('capability-runtime');
    recordCapabilityLifecycle(trace, {
      capabilityKey: `plugin:${pluginId}`,
      action,
      ...(detail ? { detail } : {}),
    });
  } catch (error) {
    logger.warn('capability package lifecycle recording failed', {
      pluginId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function recordBundledHostCapabilityLifecycle(
  capabilityId: string,
  action: 'loaded' | 'unloaded' | 'rolled_back' | 'failed',
  detail?: string,
): void {
  try {
    trace ??= new TurnTraceRecorder('capability-runtime');
    recordCapabilityLifecycle(trace, {
      capabilityKey: `capability:${capabilityId}`,
      action,
      ...(detail ? { detail } : {}),
    });
  } catch (error) {
    logger.warn('bundled host capability lifecycle recording failed', {
      capabilityId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
