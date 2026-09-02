// ============================================================================
// N-EVAL-L3-HARNESS：StandaloneAgentAdapter 的 cancelActiveRun 与跑题期间的无头问句探针
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StandaloneAgentAdapter } from '../../../src/host/testing/agentAdapter';
import { hasInteractiveUi, setBrowserWindowInteractionProbe } from '../../../src/host/platform/windowBridge';

const loops: Array<{ cancel: ReturnType<typeof vi.fn>; release: () => void }> = [];
const probeDuringRun: boolean[] = [];

vi.mock('../../../src/host/agent/agentLoop', () => ({
  AgentLoop: class {
    cancel = vi.fn(async () => { this.release(); });
    release: () => void = () => {};
    constructor(_config: unknown) { loops.push(this); }
    async run(): Promise<void> {
      probeDuringRun.push(hasInteractiveUi());
      await new Promise<void>((resolve) => { this.release = resolve; });
    }
  },
}));
vi.mock('../../../src/host/prompts/builder', () => ({ SYSTEM_PROMPT: 'test system prompt' }));
vi.mock('../../../src/host/tools/toolExecutor', () => ({ ToolExecutor: class { constructor(_config: unknown) {} } }));
vi.mock('../../../src/host/telemetry', () => ({
  getTelemetryCollector: () => ({ startSession: vi.fn(), endSession: vi.fn(), handleEvent: vi.fn(), createAdapter: vi.fn(() => ({})) }),
}));
vi.mock('../../../src/host/services/core/databaseService', () => ({ getDatabase: () => ({ isReady: false }) }));

function makeAdapter(): StandaloneAgentAdapter {
  return new StandaloneAgentAdapter({ workingDirectory: '/tmp', modelConfig: { provider: 'mock', model: 'mock-model' } });
}

beforeEach(() => {
  loops.length = 0;
  probeDuringRun.length = 0;
  // 模拟 eval 进程里挂着一个「有交互界面」的探针（web/mock 窗口），跑题期间必须被压成 false
  setBrowserWindowInteractionProbe(() => true);
});

describe('StandaloneAgentAdapter.cancelActiveRun', () => {
  it('题超时后 cancelActiveRun 真的调 loop.cancel，sendMessage 随之收尾', async () => {
    const adapter = makeAdapter();
    adapter.configureEvaluationCase('case-x');
    const pending = adapter.sendMessage('hello');
    await vi.waitFor(() => expect(loops).toHaveLength(1));
    await adapter.cancelActiveRun();
    expect(loops[0].cancel).toHaveBeenCalledWith('user');
    await expect(pending).resolves.toMatchObject({ errors: [] });
    // 再调一次是安全 no-op
    await expect(adapter.cancelActiveRun()).resolves.toBeUndefined();
    expect(loops[0].cancel).toHaveBeenCalledTimes(1);
  });

  it('标了 evaluationTestId 的 case 跑题期间 hasInteractiveUi() 为 false，结束后恢复原探针', async () => {
    const adapter = makeAdapter();
    adapter.configureEvaluationCase('case-x');
    const pending = adapter.sendMessage('hello');
    await vi.waitFor(() => expect(loops).toHaveLength(1));
    expect(probeDuringRun).toEqual([false]);
    expect(hasInteractiveUi()).toBe(false);
    loops[0].release();
    await pending;
    expect(hasInteractiveUi()).toBe(true);
  });

  it('没标 evaluationTestId（非 eval 用法）不动探针', async () => {
    const adapter = makeAdapter();
    const pending = adapter.sendMessage('hello');
    await vi.waitFor(() => expect(loops).toHaveLength(1));
    expect(probeDuringRun).toEqual([true]);
    loops[0].release();
    await pending;
    expect(hasInteractiveUi()).toBe(true);
  });
});
