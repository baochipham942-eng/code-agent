import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { TurnTraceRecorder } from '../../../src/host/agent/runtime/turnTrace';
import {
  CapabilityUnitRuntime,
  type CapabilityUnit,
} from '../../../src/host/services/capability/capabilityUnitRuntime';
import { recordCapabilityLifecycle } from '../../../src/host/services/capability/capabilityLifecycleTrace';
import { ToolSearchService } from '../../../src/host/services/toolSearch';

describe('capability lifecycle headless harness', () => {
  it('loads and unloads a real ToolSearch skill unit and persists raw JSONL events', async () => {
    const sessionId = 'n-ledger-p2-real-harness';
    const traceDir = path.resolve(os.tmpdir(), '..', 'n-ledger-p2-traces');
    const tracePath = path.join(traceDir, `${sessionId}.jsonl`);
    await fs.rm(tracePath, { force: true });

    const trace = new TurnTraceRecorder(sessionId, traceDir);
    const runtime = new CapabilityUnitRuntime((data) => recordCapabilityLifecycle(trace, data));
    const toolSearch = new ToolSearchService();
    const realSkillUnit: CapabilityUnit = {
      id: 'ledger-p2-harness',
      type: 'skill',
      depends: [],
      provides: ['skill:ledger-p2-harness'],
      async register(context) {
        await context.register({
          apply: () => toolSearch.registerSkill(
            'ledger-p2-harness',
            'N-LEDGER-P2 real reversible registration harness',
          ),
          inverse: () => { toolSearch.unregisterSkill('ledger-p2-harness'); },
        });
      },
    };

    await runtime.load(realSkillUnit);
    const loadedSearch = await toolSearch.searchTools('ledger-p2-harness');
    expect(loadedSearch.tools.map((tool) => tool.name)).toContain('skill:ledger-p2-harness');

    await runtime.unload(realSkillUnit.id);
    const unloadedSearch = await toolSearch.searchTools('ledger-p2-harness');
    expect(unloadedSearch.tools.map((tool) => tool.name)).not.toContain('skill:ledger-p2-harness');

    const rawLines = (await fs.readFile(tracePath, 'utf-8')).trim().split('\n');
    expect(rawLines).toHaveLength(2);
    expect(rawLines.map((line) => JSON.parse(line).data.action)).toEqual(['loaded', 'unloaded']);
    for (const line of rawLines) console.log(`CAPABILITY_TRACE_RAW ${line}`);
  });
});
