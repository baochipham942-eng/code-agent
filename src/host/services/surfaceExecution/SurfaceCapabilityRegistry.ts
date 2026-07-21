import type {
  SurfaceCapabilityManifestV1,
  SurfaceGrantCapabilityV1,
  SurfaceKind,
} from '../../../shared/contract/surfaceExecution';
import {
  getBrowserComputerSurfaceCapabilityDescriptor,
  type BrowserComputerCatalogTool,
  type BrowserComputerSurfaceCapabilityDescriptor,
} from '../../../shared/utils/browserComputerActionCatalog';

export class SurfaceCapabilityUnsupportedError extends Error {
  readonly code = 'SURFACE_CAPABILITY_UNSUPPORTED' as const;

  constructor(
    readonly toolName: string,
    readonly action: string,
  ) {
    super(`Surface capability is not registered: ${toolName}.${action}`);
    this.name = 'SurfaceCapabilityUnsupportedError';
  }
}

export class SurfaceCapabilityRegistry {
  resolve(
    toolName: BrowserComputerCatalogTool,
    action: string,
    args?: Record<string, unknown>,
  ): BrowserComputerSurfaceCapabilityDescriptor {
    const descriptor = getBrowserComputerSurfaceCapabilityDescriptor(toolName, action, args);
    if (!descriptor) throw new SurfaceCapabilityUnsupportedError(toolName, action);
    return descriptor;
  }

  assertGrantCapabilities(
    required: readonly SurfaceGrantCapabilityV1[],
    granted: readonly SurfaceGrantCapabilityV1[],
  ): void {
    const missing = required.filter((capability) => !granted.includes(capability));
    if (missing.length > 0) {
      throw new SurfaceCapabilityUnsupportedError('grant', missing.join(','));
    }
  }

  buildManifest(input: {
    surface: SurfaceKind;
    provider: string;
    protocolVersion?: string;
    operations: string[];
    observationKinds?: SurfaceCapabilityManifestV1['observationKinds'];
    supports?: Partial<SurfaceCapabilityManifestV1['supports']>;
  }): SurfaceCapabilityManifestV1 {
    return {
      version: 1,
      surface: input.surface,
      provider: input.provider,
      protocolVersion: input.protocolVersion || 'surface-execution-v1',
      operations: Array.from(new Set(input.operations)).sort(),
      observationKinds: input.observationKinds || [],
      supports: {
        cancel: input.supports?.cancel ?? false,
        pause: input.supports?.pause ?? false,
        takeover: input.supports?.takeover ?? false,
        cleanup: input.supports?.cleanup ?? false,
        successorObservation: input.supports?.successorObservation ?? false,
      },
    };
  }
}

