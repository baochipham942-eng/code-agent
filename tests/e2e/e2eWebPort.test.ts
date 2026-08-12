import { describe, expect, it } from 'vitest';
import { resolveE2eWebPort } from './e2eWebPort';

describe('resolveE2eWebPort', () => {
  it('保留显式 E2E_WEB_PORT', () => {
    expect(resolveE2eWebPort({ explicitPort: '18180', pid: 12_001 })).toBe(18_180);
  });

  it('为两个并发运行实例派生不同的高位端口', () => {
    const first = resolveE2eWebPort({ explicitPort: undefined, pid: 12_001 });
    const second = resolveE2eWebPort({ explicitPort: undefined, pid: 12_002 });

    expect(first).toBeGreaterThanOrEqual(20_000);
    expect(second).toBeGreaterThanOrEqual(20_000);
    expect(first).not.toBe(second);
  });

  it('起前探测到端口被占用时顺延', () => {
    const derivedPort = resolveE2eWebPort({ explicitPort: undefined, pid: 12_003 });
    const port = resolveE2eWebPort({
      explicitPort: undefined,
      pid: 12_003,
      isPortInUse: (candidate) => candidate === derivedPort,
    });

    expect(port).toBe(derivedPort + 1);
  });
});
