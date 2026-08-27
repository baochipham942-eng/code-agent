import {
  discoverLocalAgentEngineModels,
  type AgentEngineModelDiscoveryProvider,
  type AgentEngineModelDiscoveryResult,
} from '../../src/host/services/agentEngine/agentEngineModelCatalog';

const PROBE_WALL_TIME_MS = 8_000;
const PROBE_COUNT = 3;

class FakeProbeClock {
  nowMs = 0;
  probeCalls = 0;
  private pending: Array<{ dueAt: number; resolve: () => void }> = [];

  probe(index: number): Promise<AgentEngineModelDiscoveryResult> {
    this.probeCalls += 1;
    const dueAt = this.nowMs + PROBE_WALL_TIME_MS;
    return new Promise((resolve) => {
      this.pending.push({
        dueAt,
        resolve: () => resolve({
          engines: [{
            kind: 'codex_cli',
            defaultModel: `fixture-${index}`,
            models: [{
              id: `fixture-${index}`,
              label: `Fixture ${index}`,
              capabilities: ['code'],
            }],
          }],
          diagnostics: [],
        }),
      });
    });
  }

  flushNext(): void {
    const nextDueAt = Math.min(...this.pending.map((entry) => entry.dueAt));
    this.nowMs = nextDueAt;
    const ready = this.pending.filter((entry) => entry.dueAt <= nextDueAt);
    this.pending = this.pending.filter((entry) => entry.dueAt > nextDueAt);
    ready.forEach((entry) => entry.resolve());
  }
}

function buildProbes(clock: FakeProbeClock): AgentEngineModelDiscoveryProvider[] {
  return Array.from({ length: PROBE_COUNT }, (_, index) => () => clock.probe(index));
}

async function measureLegacySerial(clock: FakeProbeClock): Promise<void> {
  for (const probe of buildProbes(clock)) {
    const pending = probe();
    clock.flushNext();
    await pending;
  }
}

async function measureProductionParallel(clock: FakeProbeClock): Promise<void> {
  const pending = discoverLocalAgentEngineModels(clock.nowMs, { probes: buildProbes(clock) });
  // Promise.all invokes every injected probe synchronously before it awaits any result.
  clock.flushNext();
  await pending;
}

const mode = process.argv.includes('--before') ? 'before' : 'after';
const clock = new FakeProbeClock();

if (mode === 'before') {
  await measureLegacySerial(clock);
} else {
  await measureProductionParallel(clock);
}

console.log(JSON.stringify({
  mode,
  fixture: {
    probeCount: PROBE_COUNT,
    probeWallTimeMs: PROBE_WALL_TIME_MS,
    fakeNow: true,
    fakeProbe: true,
    shellExecutions: 0,
  },
  measurement: {
    simulatedDurationMs: clock.nowMs,
    probeCalls: clock.probeCalls,
  },
}, null, 2));
