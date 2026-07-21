import type {
  SurfaceGrantCapabilityV1,
  SurfaceKind,
} from '../../../shared/contract/surfaceExecution';
import {
  BROWSER_SURFACE_OPERATIONS,
  DEFAULT_BROWSER_PROVIDER,
  RELAY_BROWSER_PROVIDER,
  RELAY_BROWSER_SURFACE_OPERATIONS,
} from './surfaceBrowserRuntimeTypes';

export type SurfaceProviderClassV1 =
  | 'browser'
  | 'computer'
  | 'multi-browser'
  | 'remote-browser'
  | 'mobile'
  | 'in-app-preview';

type SurfaceProviderAvailabilityV1 = 'available' | 'gated';

type SurfaceProviderTargetBoundaryV1 =
  | 'browser-tab-document'
  | 'computer-app-window'
  | 'mobile-app-screen'
  | 'in-app-document';

export interface SurfaceProviderRegistrationV1 {
  version: 1;
  providerId: string;
  providerClass: SurfaceProviderClassV1;
  executionSurface: SurfaceKind;
  availability: SurfaceProviderAvailabilityV1;
  capabilities: SurfaceGrantCapabilityV1[];
  operations: string[];
  boundaries: {
    target: {
      kind: SurfaceProviderTargetBoundaryV1;
      authority: 'host-issued';
      revisionRequired: true;
    };
    input: {
      delivery: 'host-mediated';
      rawAuthority: 'forbidden';
      secretTransport: 'reference-only';
      maxPayloadBytes: number;
    };
    cleanup: {
      owner: 'host' | 'provider';
      obligations: string[];
      failureCode: 'SURFACE_CLEANUP_FAILED';
    };
  };
  decisionGate?: 'G4';
  deferReason?: string;
}

export type SurfaceProviderRegistryFailureReasonV1 =
  | 'provider_not_registered'
  | 'provider_gate_pending'
  | 'surface_mismatch'
  | 'operation_unsupported'
  | 'capability_unsupported'
  | 'payload_too_large';

export class SurfaceProviderRegistryError extends Error {
  readonly code = 'SURFACE_CAPABILITY_UNSUPPORTED' as const;

  constructor(
    readonly reason: SurfaceProviderRegistryFailureReasonV1,
    readonly providerId: string,
    readonly operation?: string,
  ) {
    super(`Surface provider request rejected: ${reason}`);
    this.name = 'SurfaceProviderRegistryError';
  }
}

export interface SurfaceProviderG4DecisionV1 {
  row: string;
  status: 'evidence-backed-defer';
  gate: 'G4';
  reason: string;
  evidenceRequired: string[];
}

const BROWSER_CAPABILITIES: SurfaceGrantCapabilityV1[] = [
  'observe',
  'input',
  'navigate',
  'file',
  'secret',
  'destructive',
];

const COMPUTER_CAPABILITIES: SurfaceGrantCapabilityV1[] = [
  'observe',
  'input',
  'file',
  'secret',
  'destructive',
];

function browserBoundaries(
  cleanupOwner: 'host' | 'provider',
  cleanupObligations: string[],
): SurfaceProviderRegistrationV1['boundaries'] {
  return {
    target: {
      kind: 'browser-tab-document',
      authority: 'host-issued',
      revisionRequired: true,
    },
    input: {
      delivery: 'host-mediated',
      rawAuthority: 'forbidden',
      secretTransport: 'reference-only',
      maxPayloadBytes: 256 * 1024,
    },
    cleanup: {
      owner: cleanupOwner,
      obligations: cleanupObligations,
      failureCode: 'SURFACE_CLEANUP_FAILED',
    },
  };
}

function computerBoundaries(
  kind: 'computer-app-window' | 'mobile-app-screen',
  cleanupObligations: string[],
): SurfaceProviderRegistrationV1['boundaries'] {
  return {
    target: {
      kind,
      authority: 'host-issued',
      revisionRequired: true,
    },
    input: {
      delivery: 'host-mediated',
      rawAuthority: 'forbidden',
      secretTransport: 'reference-only',
      maxPayloadBytes: 128 * 1024,
    },
    cleanup: {
      owner: 'host',
      obligations: cleanupObligations,
      failureCode: 'SURFACE_CLEANUP_FAILED',
    },
  };
}

const DEFAULT_SURFACE_PROVIDER_REGISTRATIONS_V1: readonly SurfaceProviderRegistrationV1[] = [
  {
    version: 1,
    providerId: DEFAULT_BROWSER_PROVIDER,
    providerClass: 'browser',
    executionSurface: 'browser',
    availability: 'available',
    capabilities: BROWSER_CAPABILITIES,
    operations: BROWSER_SURFACE_OPERATIONS,
    boundaries: browserBoundaries('host', [
      'revoke-grant',
      'close-isolated-context',
      'release-provider-resources',
    ]),
  },
  {
    version: 1,
    providerId: RELAY_BROWSER_PROVIDER,
    providerClass: 'browser',
    executionSurface: 'browser',
    availability: 'available',
    capabilities: BROWSER_CAPABILITIES,
    operations: RELAY_BROWSER_SURFACE_OPERATIONS,
    boundaries: browserBoundaries('host', [
      'revoke-grant',
      'revoke-tab-lease',
      'return-borrowed-tab',
    ]),
  },
  {
    version: 1,
    providerId: 'cua-driver',
    providerClass: 'computer',
    executionSurface: 'computer',
    availability: 'available',
    capabilities: COMPUTER_CAPABILITIES,
    operations: ['act'],
    boundaries: computerBoundaries('computer-app-window', [
      'revoke-grant',
      'release-input-lock',
      'end-provider-session',
    ]),
  },
  {
    version: 1,
    providerId: 'future:multi-browser',
    providerClass: 'multi-browser',
    executionSurface: 'browser',
    availability: 'gated',
    capabilities: BROWSER_CAPABILITIES,
    operations: BROWSER_SURFACE_OPERATIONS,
    boundaries: browserBoundaries('host', [
      'revoke-grant',
      'return-or-close-each-tab',
      'release-browser-contexts',
    ]),
    decisionGate: 'G4',
    deferReason: 'Requires cross-browser demand and compatibility benchmark evidence.',
  },
  {
    version: 1,
    providerId: 'future:remote-managed',
    providerClass: 'remote-browser',
    executionSurface: 'browser',
    availability: 'gated',
    capabilities: BROWSER_CAPABILITIES,
    operations: BROWSER_SURFACE_OPERATIONS,
    boundaries: browserBoundaries('provider', [
      'revoke-grant',
      'destroy-remote-context',
      'delete-remote-profile',
    ]),
    decisionGate: 'G4',
    deferReason: 'Requires demand, latency, success-rate, isolation, and cost benchmarks.',
  },
  {
    version: 1,
    providerId: 'future:mobile',
    providerClass: 'mobile',
    executionSurface: 'computer',
    availability: 'gated',
    capabilities: COMPUTER_CAPABILITIES,
    operations: ['observe', 'act'],
    boundaries: computerBoundaries('mobile-app-screen', [
      'revoke-grant',
      'release-input-lock',
      'release-device-lease',
    ]),
    decisionGate: 'G4',
    deferReason: 'Requires mobile task demand, device-cloud isolation, and input reliability benchmarks.',
  },
  {
    version: 1,
    providerId: 'future:in-app-preview',
    providerClass: 'in-app-preview',
    executionSurface: 'browser',
    availability: 'gated',
    capabilities: ['observe', 'input', 'navigate', 'file'],
    operations: ['navigate', 'click', 'type', 'screenshot', 'get_content', 'get_elements'],
    boundaries: {
      ...browserBoundaries('host', ['revoke-grant', 'close-preview-context']),
      target: {
        kind: 'in-app-document',
        authority: 'host-issued',
        revisionRequired: true,
      },
    },
    decisionGate: 'G4',
    deferReason: 'Requires in-app preview ownership and isolation benchmark evidence.',
  },
];

export const SURFACE_PROVIDER_G4_DECISIONS_V1: readonly SurfaceProviderG4DecisionV1[] = [
  {
    row: 'multi-browser-provider',
    status: 'evidence-backed-defer',
    gate: 'G4',
    reason: 'The API boundary is declared; implementation waits for measured cross-browser demand and parity gaps.',
    evidenceRequired: ['weekly-active-demand', 'task-success-delta', 'compatibility-failure-rate'],
  },
  {
    row: 'remote-managed-browser-pool',
    status: 'evidence-backed-defer',
    gate: 'G4',
    reason: 'Remote infrastructure would expand data, identity, and cleanup scope without a frozen benchmark.',
    evidenceRequired: ['p95-latency', 'success-rate-delta', 'cost-per-successful-run', 'isolation-audit'],
  },
  {
    row: 'mobile-device-cloud',
    status: 'evidence-backed-defer',
    gate: 'G4',
    reason: 'A real device pool and device-cloud contract require separate security and reliability validation.',
    evidenceRequired: ['mobile-task-demand', 'input-delivery-rate', 'device-cleanup-rate', 'cost-per-run'],
  },
  {
    row: 'windows-linux-profile-and-computer-provider',
    status: 'evidence-backed-defer',
    gate: 'G4',
    reason: 'No approved Windows/Linux provider, profile credential path, or platform test environment is in scope.',
    evidenceRequired: ['platform-provider-contract', 'credential-isolation-review', 'real-app-regression-baseline'],
  },
  {
    row: 'in-app-preview-provider',
    status: 'evidence-backed-defer',
    gate: 'G4',
    reason: 'The provider seam is declared; implementation waits for target ownership and sandbox evidence.',
    evidenceRequired: ['preview-ownership-contract', 'sandbox-escape-tests', 'workbuddy-success-delta'],
  },
];

function cloneRegistration(registration: SurfaceProviderRegistrationV1): SurfaceProviderRegistrationV1 {
  return structuredClone(registration);
}

function normalizedStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort();
}

export class SurfaceProviderRegistry {
  private readonly registrations = new Map<string, SurfaceProviderRegistrationV1>();

  constructor(
    registrations: readonly SurfaceProviderRegistrationV1[] = DEFAULT_SURFACE_PROVIDER_REGISTRATIONS_V1,
  ) {
    for (const registration of registrations) this.register(registration);
  }

  register(input: SurfaceProviderRegistrationV1): void {
    const providerId = input.providerId.trim();
    if (!providerId || this.registrations.has(providerId)) {
      throw new Error(`Surface provider registration is invalid or duplicated: ${providerId || 'empty'}`);
    }
    if (!Number.isSafeInteger(input.boundaries.input.maxPayloadBytes)
      || input.boundaries.input.maxPayloadBytes <= 0
      || input.boundaries.cleanup.obligations.length === 0) {
      throw new Error(`Surface provider boundaries are incomplete: ${providerId}`);
    }
    const registration = cloneRegistration({
      ...input,
      providerId,
      capabilities: Array.from(new Set(input.capabilities)),
      operations: normalizedStrings(input.operations),
      boundaries: {
        ...input.boundaries,
        target: { ...input.boundaries.target },
        input: { ...input.boundaries.input },
        cleanup: {
          ...input.boundaries.cleanup,
          obligations: normalizedStrings(input.boundaries.cleanup.obligations),
        },
      },
    });
    this.registrations.set(providerId, registration);
  }

  describe(providerId: string): SurfaceProviderRegistrationV1 | null {
    const registration = this.registrations.get(providerId);
    return registration ? cloneRegistration(registration) : null;
  }

  list(): SurfaceProviderRegistrationV1[] {
    return Array.from(this.registrations.values())
      .map(cloneRegistration)
      .sort((left, right) => left.providerId.localeCompare(right.providerId));
  }

  resolveForExecution(input: {
    providerId: string;
    surface: SurfaceKind;
    operation: string;
    requiredCapabilities: readonly SurfaceGrantCapabilityV1[];
    payloadBytes: number;
  }): SurfaceProviderRegistrationV1 {
    const registration = this.registrations.get(input.providerId);
    if (!registration) {
      throw new SurfaceProviderRegistryError(
        'provider_not_registered',
        input.providerId,
        input.operation,
      );
    }
    if (registration.availability !== 'available') {
      throw new SurfaceProviderRegistryError(
        'provider_gate_pending',
        input.providerId,
        input.operation,
      );
    }
    if (registration.executionSurface !== input.surface) {
      throw new SurfaceProviderRegistryError(
        'surface_mismatch',
        input.providerId,
        input.operation,
      );
    }
    if (!registration.operations.includes(input.operation)) {
      throw new SurfaceProviderRegistryError(
        'operation_unsupported',
        input.providerId,
        input.operation,
      );
    }
    if (input.requiredCapabilities.some((capability) => !registration.capabilities.includes(capability))) {
      throw new SurfaceProviderRegistryError(
        'capability_unsupported',
        input.providerId,
        input.operation,
      );
    }
    if (!Number.isSafeInteger(input.payloadBytes)
      || input.payloadBytes < 0
      || input.payloadBytes > registration.boundaries.input.maxPayloadBytes) {
      throw new SurfaceProviderRegistryError(
        'payload_too_large',
        input.providerId,
        input.operation,
      );
    }
    return cloneRegistration(registration);
  }
}

