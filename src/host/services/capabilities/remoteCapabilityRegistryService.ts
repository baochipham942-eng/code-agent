// ============================================================================
// Remote signed capability registry reader
// ============================================================================

import type {
  CapabilityCenterDiagnostic,
  CapabilityCenterItem,
} from '../../../shared/contract/capability';
import type { ControlPlaneDiagnostic } from '../../../shared/contract/controlPlane';
import { CLOUD, CLOUD_ENDPOINTS } from '../../../shared/constants';
import {
  getControlPlanePublicKeysFromEnv,
  isControlPlaneEnvelope,
  verifyControlPlaneEnvelope,
  type ControlPlanePublicKeys,
} from '../cloud/controlPlaneTrust';
import { createLogger } from '../infra/logger';
import {
  parseCapabilityRegistryPayload,
  type ParsedCapabilityRegistrySourceTrust,
} from './curatedCapabilityRegistry';

const logger = createLogger('RemoteCapabilityRegistryService');

export interface CapabilityRegistryPayload {
  version?: string;
  source?: Record<string, unknown>;
  items: unknown[];
  revokedIds?: string[];
}

export interface RemoteCapabilityRegistryReadResult {
  items: CapabilityCenterItem[];
  diagnostics: CapabilityCenterDiagnostic[];
}

export interface RemoteCapabilityRegistryServiceOptions {
  getAccessToken?: () => Promise<string | null>;
  controlPlanePublicKeys?: ControlPlanePublicKeys;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  now?: number;
}

function diagnostic(
  code: string,
  message: string,
  extra: Partial<CapabilityCenterDiagnostic> = {},
): CapabilityCenterDiagnostic {
  return {
    source: 'registry',
    severity: extra.severity ?? 'warning',
    code,
    message,
    ...(extra.path ? { path: extra.path } : {}),
    ...(extra.itemId ? { itemId: extra.itemId } : {}),
    ...(extra.blocking ? { blocking: extra.blocking } : {}),
    ...(extra.expectedHash ? { expectedHash: extra.expectedHash } : {}),
    ...(extra.actualHash ? { actualHash: extra.actualHash } : {}),
  };
}

function trustDiagnosticToCapabilityDiagnostic(
  entry: ControlPlaneDiagnostic,
  endpoint: string,
): CapabilityCenterDiagnostic {
  return diagnostic(
    `remote_${entry.code}`,
    entry.message,
    {
      path: endpoint,
      severity: entry.severity,
      expectedHash: entry.expected,
      actualHash: entry.actual,
      blocking: entry.severity === 'error',
    },
  );
}

function hasPublicKeys(keys: ControlPlanePublicKeys): boolean {
  return Object.keys(keys).length > 0;
}

function defaultCapabilityRegistryEndpoint(): string {
  return `${CLOUD_ENDPOINTS.baseUrl}/api/v1/capabilities`;
}

function fallbackCapabilityRegistryEndpoint(): string {
  return `${CLOUD_ENDPOINTS.baseUrl}/api/v1/control-plane?artifact=capabilities`;
}

export class RemoteCapabilityRegistryService {
  private options: RemoteCapabilityRegistryServiceOptions;

  constructor(options: RemoteCapabilityRegistryServiceOptions = {}) {
    this.options = options;
  }

  setOptions(options: RemoteCapabilityRegistryServiceOptions): void {
    this.options = {
      ...this.options,
      ...options,
    };
  }

  async readRegistry(): Promise<RemoteCapabilityRegistryReadResult> {
    const publicKeys = this.options.controlPlanePublicKeys || getControlPlanePublicKeysFromEnv();
    if (!hasPublicKeys(publicKeys)) {
      return {
        items: [],
        diagnostics: [diagnostic(
          'remote_registry_public_keys_missing',
          'Skipped remote capability registry because no control-plane public keys are configured.',
        )],
      };
    }

    const endpoints = this.options.endpoint
      ? [this.options.endpoint]
      : [defaultCapabilityRegistryEndpoint(), fallbackCapabilityRegistryEndpoint()];
    let lastDiagnostics: CapabilityCenterDiagnostic[] = [];
    for (const endpoint of endpoints) {
      const result = await this.fetchTrustedRegistry(endpoint, publicKeys);
      const shouldTryFallback = result.diagnostics.some((entry) => entry.code === 'remote_registry_fetch_failed');
      if (!shouldTryFallback) {
        return result;
      }
      lastDiagnostics = result.diagnostics;
    }

    return { items: [], diagnostics: lastDiagnostics };
  }

  private async fetchTrustedRegistry(
    endpoint: string,
    publicKeys: ControlPlanePublicKeys,
  ): Promise<RemoteCapabilityRegistryReadResult> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), CLOUD.FETCH_TIMEOUT);
      const headers: Record<string, string> = {};
      const accessToken = await this.options.getAccessToken?.().catch((error) => {
        logger.warn('Failed to read capability registry access token', { error: String(error) });
        return null;
      });
      if (accessToken) {
        headers.Authorization = `Bearer ${accessToken}`;
      }

      const response = await (this.options.fetchImpl || fetch)(endpoint, {
        headers,
        signal: controller.signal,
      });

      if (!response.ok) {
        return {
          items: [],
          diagnostics: [diagnostic(
            'remote_registry_fetch_failed',
            `Skipped remote capability registry because the control plane returned HTTP ${response.status}.`,
            { path: endpoint },
          )],
        };
      }

      const value: unknown = await response.json();
      if (!isControlPlaneEnvelope(value)) {
        return {
          items: [],
          diagnostics: [diagnostic(
            'remote_invalid_envelope',
            'Skipped remote capability registry because the response is not a signed control-plane envelope.',
            { path: endpoint, severity: 'error', blocking: true },
          )],
        };
      }

      const trust = verifyControlPlaneEnvelope<CapabilityRegistryPayload>(value, {
        kind: 'capability_registry',
        publicKeys,
        requireSignature: true,
        now: this.options.now,
      });
      if (!trust.trusted || !trust.payload) {
        return {
          items: [],
          diagnostics: trust.diagnostics.map((entry) => trustDiagnosticToCapabilityDiagnostic(entry, endpoint)),
        };
      }

      const sourceTrust: ParsedCapabilityRegistrySourceTrust = {
        ...(trust.contentHash ? { contentHash: trust.contentHash } : {}),
        ...(trust.expiresAt ? { expiresAt: trust.expiresAt } : {}),
        ...(trust.keyId ? { keyId: trust.keyId } : {}),
      };
      const parsed = parseCapabilityRegistryPayload(trust.payload, {
        sourcePath: endpoint,
        sourceKind: 'remote',
        idPrefix: 'remote',
        registryFileHash: trust.contentHash || value.contentHash,
        trustMode: 'trusted_envelope',
        sourceTrust,
      });
      return parsed;
    } catch (error) {
      logger.warn('Failed to fetch remote capability registry', { endpoint, error: String(error) });
      return {
        items: [],
        diagnostics: [diagnostic(
          'remote_registry_fetch_failed',
          'Skipped remote capability registry because it could not be fetched.',
          { path: endpoint },
        )],
      };
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }
}

let instance: RemoteCapabilityRegistryService | null = null;

export function getRemoteCapabilityRegistryService(): RemoteCapabilityRegistryService {
  if (!instance) {
    instance = new RemoteCapabilityRegistryService();
  }
  return instance;
}
