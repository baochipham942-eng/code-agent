import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'child_process';
import { runVerifyGate } from '../../../src/host/agent/goalVerifyGate';

/**
 * Node 文档：child 的 'error' 事件在三种场景触发——spawn 失败、kill 失败、send
 * 失败。超时路径里 timer 先调用 child.kill()，若 kill 本身失败（如 EPERM）会
 * 触发 'error'，此时进程其实已经跑起来过，只是没能在时限内被终止——不能按
 * "进程根本没起来"处理，否则闸1 会把它误判成 infraFailure 走降级放行（假绿，
 * 正好违背"infra 判定窄口径"的本意）。
 */
class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
}

describe('runVerifyGate — 超时后 kill 失败不误标 spawnFailed', () => {
  it('kill 失败（超时触发 kill 但 kill 本身抛 error）→ 仍按超时语义收尾，spawnFailed:false', async () => {
    const fakeChild = new FakeChildProcess();
    fakeChild.kill.mockImplementation(() => {
      // kill 失败：异步触发 'error'（真实 Node 行为是异步的，不能同步 emit）
      setImmediate(() => fakeChild.emit('error', new Error('kill EPERM')));
    });
    vi.mocked(spawn).mockReturnValue(fakeChild as unknown as ReturnType<typeof spawn>);

    const result = await runVerifyGate('sleep 999', process.cwd(), 10);

    expect(result).toMatchObject({
      pass: false,
      exitCode: null,
      timedOut: true,
      spawnFailed: false,
    });
    expect(fakeChild.kill).toHaveBeenCalled();
  });

  it('正常 spawn 失败（timer 未触发前就报错）→ 仍是 spawnFailed:true，不受本次修复影响', async () => {
    const fakeChild = new FakeChildProcess();
    vi.mocked(spawn).mockReturnValue(fakeChild as unknown as ReturnType<typeof spawn>);

    const resultPromise = runVerifyGate('echo hi', process.cwd(), 5000);
    fakeChild.emit('error', new Error('spawn /bin/sh ENOENT'));
    const result = await resultPromise;

    expect(result).toMatchObject({
      pass: false,
      exitCode: null,
      timedOut: false,
      spawnFailed: true,
    });
  });
});
