import { afterEach, describe, expect, it } from 'vitest';
import { ConcurrencyGate } from '../../../../src/main/agent/scriptRuntime/concurrencyGate';
import { setProviderConcurrencyOverrides } from '../../../../src/main/model/concurrencyLimiter';

afterEach(() => {
  setProviderConcurrencyOverrides({});
});

function tick(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

describe('ConcurrencyGate', () => {
  it('skips a queued provider that is already at cap and admits another provider', async () => {
    setProviderConcurrencyOverrides({
      zhipu: { maxConcurrent: 1, minIntervalMs: 0 },
    });
    const gate = new ConcurrencyGate(2);

    const releaseZhipu = await gate.acquire('zhipu');

    let secondZhipuAdmitted = false;
    const secondZhipu = gate.acquire('zhipu').then((release) => {
      secondZhipuAdmitted = true;
      return release;
    });

    let openaiAdmitted = false;
    const openai = gate.acquire('openai').then((release) => {
      openaiAdmitted = true;
      return release;
    });

    await tick();
    expect(secondZhipuAdmitted).toBe(false);
    expect(openaiAdmitted).toBe(true);
    expect(gate.stats()).toEqual({ inFlight: 2, queued: 1 });

    const releaseOpenAI = await openai;
    releaseOpenAI();
    expect(secondZhipuAdmitted).toBe(false);

    releaseZhipu();
    const releaseSecondZhipu = await secondZhipu;
    expect(secondZhipuAdmitted).toBe(true);
    releaseSecondZhipu();
    expect(gate.stats()).toEqual({ inFlight: 0, queued: 0 });
  });

  it('removes queued waiters when their abort signal fires', async () => {
    const gate = new ConcurrencyGate(1);
    const release = await gate.acquire('openai');
    const controller = new AbortController();

    const queued = gate.acquire('claude', controller.signal);
    await tick();
    expect(gate.stats()).toEqual({ inFlight: 1, queued: 1 });

    controller.abort();
    await expect(queued).rejects.toThrow(/aborted while queued/);
    expect(gate.stats()).toEqual({ inFlight: 1, queued: 0 });

    release();
    expect(gate.stats()).toEqual({ inFlight: 0, queued: 0 });
  });

  it('uses canonical provider keys for alias-based provider caps', async () => {
    setProviderConcurrencyOverrides({
      anthropic: { maxConcurrent: 1, minIntervalMs: 0 },
    });
    const gate = new ConcurrencyGate(2);

    const releaseAnthropic = await gate.acquire('anthropic');
    let claudeAdmitted = false;
    const claude = gate.acquire('claude').then((release) => {
      claudeAdmitted = true;
      return release;
    });

    await tick();
    expect(claudeAdmitted).toBe(false);
    expect(gate.stats()).toEqual({ inFlight: 1, queued: 1 });

    releaseAnthropic();
    const releaseClaude = await claude;
    expect(claudeAdmitted).toBe(true);
    releaseClaude();
  });
});
