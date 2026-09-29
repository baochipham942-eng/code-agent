import { describe, expect, it } from 'vitest';
import {
  getRendererBundleReloadBlockedReason,
  resolveInstallInterruptedTaskCount,
} from '../../../src/renderer/utils/rendererBundleActivation';

const countSync = (input: Parameters<typeof getRendererBundleReloadBlockedReason>[0]) =>
  resolveInstallInterruptedTaskCount(input, async () => []);
const idle = { runningSessionCount: 0, processingSessionCount: 0, isProcessing: false };

describe('interruptible task count (via resolveInstallInterruptedTaskCount)', () => {
  it('is 0 when idle', async () => expect(await countSync(idle)).toBe(0));
  it('does not double count running vs processing sessions', async () => {
    expect(await countSync({ ...idle, runningSessionCount: 2, processingSessionCount: 1 })).toBe(2);
  });
  it('adds background and active tasks', async () => {
    expect(await countSync({ ...idle, runningSessionCount: 1, activeTaskCount: 1 })).toBe(2);
  });
  it('counts a bare isProcessing flag as one task', async () => {
    expect(await countSync({ ...idle, isProcessing: true })).toBe(1);
  });
  it('agrees with the reload guard: blocked iff count > 0', async () => {
    for (const input of [idle, { ...idle, isProcessing: true }, { ...idle, activeTaskCount: 1 }]) {
      expect(getRendererBundleReloadBlockedReason(input) !== null).toBe((await countSync(input))! > 0);
    }
  });
});

describe('resolveInstallInterruptedTaskCount', () => {
  it('merges fetched background tasks into the count', async () => {
    expect(await resolveInstallInterruptedTaskCount({ ...idle, runningSessionCount: 1 }, async () => [{}, {}])).toBe(3);
  });
  it('returns 0 when nothing runs', async () => {
    expect(await resolveInstallInterruptedTaskCount(idle, async () => [])).toBe(0);
  });
  it('returns null (unknown) when the query rejects', async () => {
    expect(await resolveInstallInterruptedTaskCount(idle, async () => { throw new Error('x'); })).toBeNull();
  });
  it('returns null when the query returns a non-array', async () => {
    expect(await resolveInstallInterruptedTaskCount(idle, async () => undefined)).toBeNull();
  });
});
