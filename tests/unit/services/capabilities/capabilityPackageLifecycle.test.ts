import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const traceRoot = path.join(os.tmpdir(), `capability-package-lifecycle-${process.pid}-${Date.now()}`);
vi.mock('../../../../src/host/platform/appPaths', () => ({ getPath: () => traceRoot }));

import { recordBundledHostCapabilityLifecycle } from '../../../../src/host/services/capabilities/capabilityPackageLifecycle';

afterAll(() => fs.rmSync(traceRoot, { recursive: true, force: true }));

describe('bundled host capability lifecycle trace', () => {
  it('uses the capability: key namespace through the shared lifecycle trace', () => {
    recordBundledHostCapabilityLifecycle('builtin.voice-live', 'rolled_back', 'activation failed');

    const rows = fs.readFileSync(path.join(traceRoot, 'traces', 'capability-runtime.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(rows.at(-1)).toMatchObject({
      type: 'capability_lifecycle',
      data: {
        capabilityKey: 'capability:builtin.voice-live',
        action: 'rolled_back',
        detail: 'activation failed',
      },
    });
  });
});
