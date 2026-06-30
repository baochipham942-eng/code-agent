import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import { promises as fsp } from 'fs';

// Veo 原生（Spec 3）：google provider 走专用 generateVeoVideo。只覆写它，其余实现保留真实。
const { generateVeoVideoMock } = vi.hoisted(() => ({ generateVeoVideoMock: vi.fn() }));
vi.mock('../../../src/host/services/media/videoGenerationService', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/host/services/media/videoGenerationService')>();
  return { ...actual, generateVeoVideo: generateVeoVideoMock };
});

import { handleGenerateDesignVideo } from '../../../src/host/ipc/workspace.ipc';
import { getUserConfigDir } from '../../../src/host/config/configPaths';

const DESIGN_DIR = path.resolve(getUserConfigDir(), 'design');

beforeEach(() => {
  generateVeoVideoMock.mockReset();
  generateVeoVideoMock.mockResolvedValue({
    buffer: Buffer.from([1, 2, 3]),
    actualModel: 'veo-3.1-fast-generate-preview',
    durationSec: 8,
  });
});

describe('handleGenerateDesignVideo — google/Veo 子分支', () => {
  it('t2v google：走 generateVeoVideo（返回 Buffer 直写）+ 成本按 8×0.72', async () => {
    const out = path.join(DESIGN_DIR, `run-veo/assets/v-${Date.now()}.mp4`);
    const res = await handleGenerateDesignVideo({
      mode: 't2v',
      prompt: 'a cat',
      model: 'veo-3.1-fast-generate-preview',
      outputPath: out,
    });

    expect(generateVeoVideoMock).toHaveBeenCalledTimes(1);
    expect(res.actualModel).toBe('veo-3.1-fast-generate-preview');
    expect(res.durationSec).toBe(8);
    expect(res.costCny).toBeCloseTo(5.76, 5); // 8 × 0.72
    expect(res.path).toBe(out);

    const written = await fsp.readFile(out);
    expect(Array.from(written)).toEqual([1, 2, 3]);

    await fsp.rm(path.dirname(path.dirname(out)), { recursive: true, force: true });
  });
});
