import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCanvasDoc } from '../../../src/renderer/components/design/designCanvasPersistence';

describe('loadCanvasDoc 外部改写归因防线', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('任一实体归因校验失败时整卷 userTouched，并输出结构化日志', async () => {
    const content = JSON.stringify({
      version: 1,
      camera: { x: 0, y: 0, scale: 1 },
      nodes: [
        { id: 'valid', src: 'a.png', x: 0, y: 0, width: 1, height: 1, createdAt: 1, createdBy: 'agent' },
        { id: 'rewritten', src: 'b.png', x: 0, y: 0, width: 1, height: 1, createdAt: 1 },
      ],
    });
    const invoke = vi.fn().mockResolvedValue({ success: true, data: content });
    Object.assign(globalThis, { window: { domainAPI: { invoke } } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const doc = await loadCanvasDoc('/tmp/run-external');

    expect(doc.nodes).toHaveLength(2);
    expect(doc.nodes.every((item) => item.userTouchedAt === 0)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('canvas attribution validation failed');
    expect(warn.mock.calls[0][1]).toMatchObject({
      event: 'canvas_attribution_degraded',
      runDir: '/tmp/run-external',
      reasons: ['invalid-attribution'],
      nodeCount: 2,
    });
  });
});
