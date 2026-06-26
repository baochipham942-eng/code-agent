import type {
  ManagedBrowserMode,
  WorkbenchActionTrace,
  WorkbenchSnapshotRef,
} from '../../../../shared/contract/desktop';
import { redactBrowserWorkbenchTraceParams } from './managedBrowserHelpers';
import type { BrowserProviderDiagnostics } from './types';

export function beginBrowserWorkbenchTrace(args: {
  toolName: string;
  action: string;
  params?: Record<string, unknown>;
  mode: ManagedBrowserMode;
  providerDiagnostics: BrowserProviderDiagnostics;
  profileDir: string;
  before: WorkbenchSnapshotRef | null;
}): WorkbenchActionTrace {
  const startedAtMs = Date.now();
  return {
    id: `trace_${startedAtMs}_${Math.random().toString(36).slice(2, 8)}`,
    targetKind: 'browser',
    toolName: args.toolName,
    action: args.action,
    mode: args.mode,
    provider: args.providerDiagnostics.provider,
    executable: args.providerDiagnostics.executable,
    cdpPort: args.providerDiagnostics.cdpPort,
    profileDir: args.profileDir,
    missingExecutable: args.providerDiagnostics.missingExecutable,
    recommendedAction: args.providerDiagnostics.recommendedAction,
    startedAtMs,
    before: args.before,
    params: redactBrowserWorkbenchTraceParams(args.toolName, args.params || {}),
    consoleErrors: [],
    networkFailures: [],
  };
}

export function finishBrowserWorkbenchTrace(
  trace: WorkbenchActionTrace,
  args: {
    success: boolean;
    error?: string | null;
    screenshotPath?: string | null;
    after: WorkbenchSnapshotRef | null;
    consoleErrors: string[];
    networkFailures: string[];
  },
): WorkbenchActionTrace {
  return {
    ...trace,
    completedAtMs: Date.now(),
    after: args.after,
    success: args.success,
    error: args.error || null,
    screenshotPath: args.screenshotPath || null,
    consoleErrors: args.consoleErrors,
    networkFailures: args.networkFailures,
  };
}
