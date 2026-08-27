import { AgentEngineRegistry } from '../../src/host/services/agentEngine/agentEngineRegistry';
import type { ExternalEngineManifest } from '../../src/shared/externalEngineManifest';

const PROBE_WALL_TIME_MS = 5801;
const MANIFEST_COUNT = 12;

const manifestTemplate: Omit<ExternalEngineManifest, 'id' | 'kind'> = {
  label: 'Probe cache fixture',
  summary: 'Deterministic fixture that never shells out.',
  iconAsset: '/fixture.svg',
  adapter: {
    transport: 'native',
    promptTransport: 'internal',
    eventFormat: 'internal',
    credentialOwner: 'neo',
    evidence: 'none',
  },
  modelSelection: 'unavailable',
  capabilities: [],
  defaultPermissionProfile: 'read_only',
  riskTier: 'low',
  reliability: {
    streamingMode: 'none',
    toolSupport: 'none',
    transcriptMode: 'unknown',
  },
  auditNotes: [],
};

const manifests: ExternalEngineManifest[] = Array.from({ length: MANIFEST_COUNT }, (_, index) => ({
  ...manifestTemplate,
  id: `probe-cache-fixture-${index}`,
  ...(index === 0 ? { kind: 'native' as const } : {}),
}));

let clockMs = 0;
let probeCalls = 0;
const registry = new AgentEngineRegistry({
  cacheTtlMs: 5000,
  manifests,
  now: () => clockMs,
});

type RegistryProbeHarness = {
  probeManifest(manifest: ExternalEngineManifest): Promise<null>;
};

// The harness replaces only the private probe boundary. Production descriptor/cache
// construction stays real, while the fixture cannot execute a local CLI.
(registry as unknown as RegistryProbeHarness).probeManifest = async () => {
  if (probeCalls % MANIFEST_COUNT === 0) clockMs += PROBE_WALL_TIME_MS;
  probeCalls += 1;
  return null;
};

async function measure(label: string): Promise<{
  label: string;
  simulatedDurationMs: number;
  probeCalls: number;
}> {
  const startedAt = clockMs;
  const callsBefore = probeCalls;
  await registry.list();
  return {
    label,
    simulatedDurationMs: clockMs - startedAt,
    probeCalls: probeCalls - callsBefore,
  };
}

const first = await measure('cold-start');
const immediateSecond = await measure('immediate-second');
registry.invalidate();
const afterInvalidate = await measure('after-invalidate');

console.log(JSON.stringify({
  fixture: {
    manifests: MANIFEST_COUNT,
    cacheTtlMs: 5000,
    probeWallTimeMs: PROBE_WALL_TIME_MS,
    shellExecutions: 0,
  },
  measurements: [first, immediateSecond, afterInvalidate],
}, null, 2));
