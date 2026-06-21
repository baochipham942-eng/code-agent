import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import os from 'os';
import { promises as fsp } from 'fs';

const { generateVideoMock, downloadVideoMock } = vi.hoisted(() => ({
  generateVideoMock: vi.fn(),
  downloadVideoMock: vi.fn(),
}));
vi.mock('../../../src/main/services/media/videoGenerationService', () => ({
  generateVideo: generateVideoMock,
  downloadVideoAsBuffer: downloadVideoMock,
}));

// 只 mock getDashscopeApiKey（handler i2v 路径用它做 key 守卫）；其余保留真实实现。
const { getDashscopeKeyMock } = vi.hoisted(() => ({ getDashscopeKeyMock: vi.fn() }));
vi.mock('../../../src/main/services/media/imageGenerationService', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/main/services/media/imageGenerationService')>();
  return { ...actual, getDashscopeApiKey: getDashscopeKeyMock };
});

import { handleGenerateDesignVideo, handleListVisualVideoModels } from '../../../src/main/ipc/workspace.ipc';
import { getUserConfigDir } from '../../../src/main/config/configPaths';

const DESIGN_DIR = path.resolve(getUserConfigDir(), 'design');

beforeEach(() => {
  generateVideoMock.mockReset();
  downloadVideoMock.mockReset();
  generateVideoMock.mockResolvedValue({ url: 'https://oss.example.com/out.mp4', actualModel: 'wan2.7-t2v', durationSec: 5 });
  downloadVideoMock.mockResolvedValue(Buffer.from('FAKEMP4'));
  getDashscopeKeyMock.mockReset();
  getDashscopeKeyMock.mockReturnValue('sk-test');
});

describe('handleGenerateDesignVideo', () => {
  it('t2v 正常路径：写 mp4 + 返回 path/actualModel/costCny/durationSec', async () => {
    const out = path.join(DESIGN_DIR, `run-test/assets/vid-${Date.now()}.mp4`);
    const res = await handleGenerateDesignVideo({ mode: 't2v', prompt: '一只猫', model: 'wan2.7-t2v', outputPath: out, durationSec: 5 });
    expect(res.path).toBe(out);
    expect(res.actualModel).toBe('wan2.7-t2v');
    expect(res.durationSec).toBe(5);
    expect(res.costCny).toBeGreaterThan(0);
    expect(await fsp.readFile(out, 'utf8')).toBe('FAKEMP4');
    await fsp.rm(path.dirname(path.dirname(out)), { recursive: true, force: true });
  });

  it('t2v 缺 prompt：抛错，不调 service（防付费空调用）', async () => {
    const out = path.join(DESIGN_DIR, 'run-x/assets/v.mp4');
    await expect(handleGenerateDesignVideo({ mode: 't2v', prompt: '   ', model: 'wan2.7-t2v', outputPath: out })).rejects.toThrow();
    expect(generateVideoMock).not.toHaveBeenCalled();
  });

  it('i2v 缺 baseImagePath：抛错，不调 service', async () => {
    const out = path.join(DESIGN_DIR, 'run-x/assets/v.mp4');
    await expect(handleGenerateDesignVideo({ mode: 'i2v', model: 'wanx2.1-i2v-turbo', outputPath: out })).rejects.toThrow();
    expect(generateVideoMock).not.toHaveBeenCalled();
  });

  it('outputPath 越界设计目录：抛「路径越界」，不调 service', async () => {
    const evil = path.join(os.tmpdir(), 'evil.mp4');
    await expect(handleGenerateDesignVideo({ mode: 't2v', prompt: 'x', model: 'wan2.7-t2v', outputPath: evil })).rejects.toThrow(/越界/);
    expect(generateVideoMock).not.toHaveBeenCalled();
  });

  it('i2v baseImagePath 越界设计目录：抛「路径越界」', async () => {
    const out = path.join(DESIGN_DIR, 'run-x/assets/v.mp4');
    const evilBase = path.join(os.tmpdir(), 'evil.png');
    await expect(
      handleGenerateDesignVideo({ mode: 'i2v', model: 'wanx2.1-i2v-turbo', baseImagePath: evilBase, outputPath: out }),
    ).rejects.toThrow(/越界/);
    expect(generateVideoMock).not.toHaveBeenCalled();
  });

  it('未知模型：抛错，不调 service', async () => {
    const out = path.join(DESIGN_DIR, 'run-x/assets/v.mp4');
    await expect(handleGenerateDesignVideo({ mode: 't2v', prompt: 'x', model: 'no-such', outputPath: out })).rejects.toThrow();
    expect(generateVideoMock).not.toHaveBeenCalled();
  });

  it('cap 不匹配（i2v 模型用于 t2v）：抛错，不调 service', async () => {
    const out = path.join(DESIGN_DIR, 'run-x/assets/v.mp4');
    await expect(handleGenerateDesignVideo({ mode: 't2v', prompt: 'x', model: 'wanx2.1-i2v-turbo', outputPath: out })).rejects.toThrow();
    expect(generateVideoMock).not.toHaveBeenCalled();
  });

  it('i2v 缺 DashScope key：抛错，不读文件不调 service', async () => {
    getDashscopeKeyMock.mockReturnValue(undefined);
    const base = path.join(DESIGN_DIR, 'run-nokey/assets/base.png'); // 故意不创建该文件
    const out = path.join(DESIGN_DIR, 'run-nokey/assets/v.mp4');
    await expect(handleGenerateDesignVideo({ mode: 'i2v', model: 'wanx2.1-i2v-turbo', baseImagePath: base, outputPath: out })).rejects.toThrow(/Key|百炼|DashScope/);
    expect(generateVideoMock).not.toHaveBeenCalled();
  });

  it('i2v 正常路径：读底图→base64 传 service→写 mp4', async () => {
    const base = path.join(DESIGN_DIR, `run-i2v/assets/base-${Date.now()}.png`);
    await fsp.mkdir(path.dirname(base), { recursive: true });
    await fsp.writeFile(base, Buffer.from('PNGDATA'));
    const out = path.join(DESIGN_DIR, 'run-i2v/assets/v.mp4');
    generateVideoMock.mockResolvedValue({ url: 'https://oss.example.com/o.mp4', actualModel: 'wanx2.1-i2v-turbo', durationSec: 5 });
    const res = await handleGenerateDesignVideo({ mode: 'i2v', model: 'wanx2.1-i2v-turbo', baseImagePath: base, outputPath: out });
    const callArg = generateVideoMock.mock.calls[0][0];
    expect(callArg.mode).toBe('i2v');
    expect(typeof callArg.imageDataUrl).toBe('string');
    expect(callArg.imageDataUrl.startsWith('data:image')).toBe(true);
    expect(res.actualModel).toBe('wanx2.1-i2v-turbo');
    await fsp.rm(path.dirname(path.dirname(base)), { recursive: true, force: true });
  });
});

describe('handleListVisualVideoModels', () => {
  it('返回全部视频模型 + available 标志 + caps/时长区间', async () => {
    const res = await handleListVisualVideoModels();
    expect(res.models.length).toBeGreaterThan(0);
    for (const m of res.models) {
      expect(typeof m.id).toBe('string');
      expect(typeof m.available).toBe('boolean');
      expect(Array.isArray(m.caps)).toBe(true);
      expect(m.maxDurationSec).toBeGreaterThanOrEqual(m.minDurationSec);
    }
  });
});
