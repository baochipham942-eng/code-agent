import type { BrowserProviderResolution } from '../browserProvider';
import type { BrowserProviderDiagnostics } from './types';

export function buildBrowserProviderDiagnostics(
  resolution: BrowserProviderResolution,
  runtime: {
    executable: string | null;
    cdpPort: number | null;
    missingExecutable?: boolean;
    recommendedAction?: string | null;
  },
): BrowserProviderDiagnostics {
  return {
    provider: resolution.provider,
    requestedProvider: resolution.requestedProvider,
    executable: runtime.executable,
    cdpPort: runtime.cdpPort,
    missingExecutable: runtime.missingExecutable ?? resolution.missingExecutable,
    recommendedAction: runtime.recommendedAction ?? resolution.recommendedAction,
    providerFallbackReason: resolution.providerFallbackReason,
  };
}

export function createInitialBrowserProviderDiagnostics(
  resolveProvider: () => BrowserProviderResolution,
): BrowserProviderDiagnostics {
  try {
    const resolution = resolveProvider();
    return {
      provider: resolution.provider,
      requestedProvider: resolution.requestedProvider,
      executable: resolution.provider === 'system-chrome-cdp' ? resolution.systemExecutable : null,
      cdpPort: null,
      missingExecutable: resolution.missingExecutable,
      recommendedAction: resolution.recommendedAction,
      providerFallbackReason: resolution.providerFallbackReason,
    };
  } catch (error) {
    return {
      provider: null,
      requestedProvider: null,
      executable: null,
      cdpPort: null,
      missingExecutable: false,
      recommendedAction: error instanceof Error ? error.message : String(error),
      providerFallbackReason: null,
    };
  }
}
