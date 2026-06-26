import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 记录 execFile 调用次数，验证探测缓存：TTL 内重复 list() 不重复探测。
const execFileCalls: string[] = [];

vi.mock('child_process', () => ({
  execFile: (
    file: string,
    args: string[],
    _opts: unknown,
    cb: (err: unknown, result: { stdout: string; stderr: string }) => void,
  ) => {
    execFileCalls.push(`${file} ${args.join(' ')}`);
    if (file === 'which' || file === 'where') {
      cb(null, { stdout: `/usr/local/bin/${args[0]}\n`, stderr: '' });
    } else {
      cb(null, { stdout: '1.0.0\n', stderr: '' });
    }
  },
}));

vi.mock('../../../../src/host/services/infra/shellEnvironment', () => ({
  getShellPath: () => '/usr/local/bin',
}));

import { AgentEngineRegistry } from '../../../../src/host/services/agentEngine/agentEngineRegistry';

beforeEach(() => {
  execFileCalls.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('AgentEngineRegistry 探测缓存', () => {
  it('TTL 内重复 list() 只探测一次', async () => {
    let clock = 1000;
    const registry = new AgentEngineRegistry({ cacheTtlMs: 5000, now: () => clock });

    await registry.list();
    const afterFirst = execFileCalls.length;
    expect(afterFirst).toBeGreaterThan(0); // 首次真探测（which + --version × 2 引擎）

    await registry.list(); // TTL 内
    expect(execFileCalls.length).toBe(afterFirst); // 零新增探测

    clock += 6000; // 越过 TTL
    await registry.list();
    expect(execFileCalls.length).toBe(afterFirst * 2); // 重新探测
  });

  it('invalidate() 强制下次 list() 重新探测', async () => {
    const clock = 1000;
    const registry = new AgentEngineRegistry({ cacheTtlMs: 5000, now: () => clock });

    await registry.list();
    const afterFirst = execFileCalls.length;

    registry.invalidate();
    await registry.list(); // 同一时刻但缓存已清

    expect(execFileCalls.length).toBe(afterFirst * 2);
  });
});
