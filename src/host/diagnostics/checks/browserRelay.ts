import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ManagedBrowserExternalBridgeState } from '../../../shared/contract/desktop';
import { BROWSER_RELAY_PROTOCOL_VERSION_V2 } from '../../../shared/contract/browserRelay';
import type { DoctorItem } from '../types';

type PathExists = (path: string) => boolean;

function extensionAvailable(
  state: ManagedBrowserExternalBridgeState,
  pathExists: PathExists,
): boolean {
  return typeof state.extensionPath === 'string'
    && state.extensionPath.length > 0
    && pathExists(join(state.extensionPath, 'manifest.json'));
}

function safeRelayError(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  return value
    .replace(/(token|authorization|cookie|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .slice(0, 500);
}

export function checkBrowserRelay(
  state: ManagedBrowserExternalBridgeState,
  pathExists: PathExists = existsSync,
): DoctorItem[] {
  const installed = extensionAvailable(state, pathExists);
  const protocol = `protocol ${BROWSER_RELAY_PROTOCOL_VERSION_V2}`;
  const tabSummary = `${state.connectedTabCount || 0} connection(s), ${state.attachedTabCount || 0} active lease(s)`;
  const base = {
    category: 'provider_health' as const,
    name: 'Browser Relay V2',
  };

  if (state.status === 'connected') {
    return [{
      ...base,
      status: installed ? 'pass' : 'warn',
      message: `connected · ${protocol} · ${tabSummary}`,
      details: 'Pairing is local-only; every tab requires an explicit owner/domain/action/time-scoped lease.',
      ...(!installed ? {
        suggestion: 'The connected extension path is unavailable to this build. Reinstall or reload the packaged extension before the next run.',
      } : {}),
    }];
  }

  if (state.status === 'error') {
    return [{
      ...base,
      status: 'fail',
      message: `error · ${protocol}`,
      details: safeRelayError(state.lastError) || safeRelayError(state.reason),
      suggestion: 'Reload the extension shipped with this Agent Neo build, then rerun doctor. Protocol or capability mismatch must not be bypassed.',
    }];
  }

  if (state.status === 'listening') {
    return [{
      ...base,
      status: 'warn',
      message: `listening · ${protocol} · waiting for extension handshake`,
      details: installed ? 'Packaged extension manifest found.' : 'Packaged extension manifest not found.',
      suggestion: installed
        ? 'Open Chrome, reload the packaged extension, and wait for the automatic local pairing handshake.'
        : 'Restore the packaged Browser Relay extension before enabling Relay tasks.',
    }];
  }

  if (state.status === 'stopped') {
    return [{
      ...base,
      status: 'warn',
      message: `stopped · ${protocol}`,
      details: installed ? 'Packaged extension manifest found.' : 'Packaged extension manifest not found.',
      suggestion: 'Start Browser Relay from the Browser Surface panel, then rerun doctor after the extension connects.',
    }];
  }

  return [{
    ...base,
    status: 'fail',
    message: `unsupported · ${protocol}`,
    suggestion: 'Use a build that includes Browser Relay V2 or choose the isolated Managed Browser provider.',
  }];
}

export async function checkCurrentBrowserRelay(): Promise<DoctorItem[]> {
  const { browserRelayService } = await import('../../services/infra/browserRelayService');
  return checkBrowserRelay(browserRelayService.getState());
}
