// ============================================================================
// WP3-1 成本安全：付费生成 handler 的 commandId 幂等契约。
// 同 commandId 的自动重试/重放（引擎超时重提、事件重放）命中缓存产物，不再发起付费
// service 调用；不带 commandId 保持既有行为；缓存产物文件已失效则重新生成。
// 覆盖 image / video（wanx/veo/seedance/minimax 同一收口）/ music / slides deck 四个付费收口（对称应用）。
// ============================================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import os from 'os';
import { promises as fsp } from 'fs';

const { generateVideoMock, downloadVideoMock } = vi.hoisted(() => ({
  generateVideoMock: vi.fn(),
  downloadVideoMock: vi.fn(),
}));
vi.mock('../../../src/host/services/media/videoGenerationService', () => ({
  generateVideo: generateVideoMock,
  downloadVideoAsBuffer: downloadVideoMock,
}));

const { generateImageMock } = vi.hoisted(() => ({ generateImageMock: vi.fn() }));
vi.mock('../../../src/host/services/media/imageGenerationService', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/host/services/media/imageGenerationService')>();
  return { ...actual, generateImage: generateImageMock };
});

const { generateMusicMock, resolveMusicEndpointMock } = vi.hoisted(() => ({
  generateMusicMock: vi.fn(),
  resolveMusicEndpointMock: vi.fn(),
}));
vi.mock('../../../src/host/services/media/musicGenerationService', () => ({
  generateMusic: generateMusicMock,
  resolveMusicModelEndpoint: resolveMusicEndpointMock,
}));

const { illustrateMock, deckGenMock, outlineMock, aiOutlineMock, saveMock } = vi.hoisted(() => ({
  illustrateMock: vi.fn(),
  deckGenMock: vi.fn(),
  outlineMock: vi.fn(),
  aiOutlineMock: vi.fn(),
  saveMock: vi.fn(),
}));
vi.mock('../../../src/host/services/design/slidesGenerator', () => ({
  generateSlidesDeck: deckGenMock,
  buildSlidesOutline: outlineMock,
}));
vi.mock('../../../src/host/services/design/slidesAiOutline', () => ({ buildAiOutline: aiOutlineMock }));
vi.mock('../../../src/host/services/design/slidesIllustrator', () => ({ illustrateSlides: illustrateMock }));
vi.mock('../../../src/host/ipc/workspaceSaveExport', () => ({ handleSaveBinaryToDownloads: saveMock }));

import {
  handleGenerateDesignImage,
  handleGenerateDesignVideo,
  handleGenerateDesignMusic,
} from '../../../src/host/ipc/workspaceDesignMedia.ipc';
import { handleGenerateSlidesDeck } from '../../../src/host/ipc/workspaceSlidesExport';
import { getUserConfigDir } from '../../../src/host/config/configPaths';

const DESIGN_DIR = path.resolve(getUserConfigDir(), 'design');
let seq = 0;
const outPath = (ext: string) => path.join(DESIGN_DIR, `run-idem/assets/out-${Date.now()}-${++seq}.${ext}`);

beforeEach(() => {
  generateVideoMock.mockReset();
  downloadVideoMock.mockReset();
  generateImageMock.mockReset();
  generateMusicMock.mockReset();
  resolveMusicEndpointMock.mockReset();
  illustrateMock.mockReset();
  deckGenMock.mockReset();
  outlineMock.mockReset();
  aiOutlineMock.mockReset();
  saveMock.mockReset();
  generateVideoMock.mockResolvedValue({ url: 'https://oss.example.com/o.mp4', actualModel: 'wan2.7-t2v', durationSec: 5 });
  downloadVideoMock.mockResolvedValue(Buffer.from('FAKEMP4'));
  generateImageMock.mockResolvedValue({ imageData: 'data:image/png;base64,QUJD', actualModel: 'wanx2.1-t2i-plus' });
  resolveMusicEndpointMock.mockReturnValue({ baseUrl: 'https://api.example.com', apiKey: 'k', modelName: 'minimax-music-2.6' });
  generateMusicMock.mockResolvedValue({ audioBuffer: Buffer.from('FAKEMP3'), actualModel: 'minimax-music-2.6' });
});

describe('handleGenerateDesignVideo commandId 幂等', () => {
  it('同 commandId 重放 → 只调一次付费 service，第二次返回缓存产物', async () => {
    const commandId = `gencmd-video-${Date.now()}`;
    const out1 = outPath('mp4');
    const first = await handleGenerateDesignVideo({ mode: 't2v', prompt: '一只猫', model: 'wan2.7-t2v', outputPath: out1, durationSec: 5, commandId });
    const out2 = outPath('mp4');
    const second = await handleGenerateDesignVideo({ mode: 't2v', prompt: '一只猫', model: 'wan2.7-t2v', outputPath: out2, durationSec: 5, commandId });
    expect(generateVideoMock).toHaveBeenCalledTimes(1);
    expect(second.path).toBe(first.path);
    expect(second.costCny).toBe(first.costCny);
    await fsp.rm(path.dirname(path.dirname(out1)), { recursive: true, force: true });
  });

  it('不同 commandId → 各自付费执行', async () => {
    const out1 = outPath('mp4');
    const out2 = outPath('mp4');
    await handleGenerateDesignVideo({ mode: 't2v', prompt: 'x', model: 'wan2.7-t2v', outputPath: out1, commandId: `gencmd-v-a-${Date.now()}` });
    await handleGenerateDesignVideo({ mode: 't2v', prompt: 'x', model: 'wan2.7-t2v', outputPath: out2, commandId: `gencmd-v-b-${Date.now()}` });
    expect(generateVideoMock).toHaveBeenCalledTimes(2);
    await fsp.rm(path.dirname(path.dirname(out1)), { recursive: true, force: true });
  });

  it('不带 commandId → 保持既有行为（每次都执行）', async () => {
    const out1 = outPath('mp4');
    const out2 = outPath('mp4');
    await handleGenerateDesignVideo({ mode: 't2v', prompt: 'x', model: 'wan2.7-t2v', outputPath: out1 });
    await handleGenerateDesignVideo({ mode: 't2v', prompt: 'x', model: 'wan2.7-t2v', outputPath: out2 });
    expect(generateVideoMock).toHaveBeenCalledTimes(2);
    await fsp.rm(path.dirname(path.dirname(out1)), { recursive: true, force: true });
  });

  it('缓存产物文件已被删除 → 缓存失效，重新生成（不返回死路径）', async () => {
    const commandId = `gencmd-video-gone-${Date.now()}`;
    const out1 = outPath('mp4');
    const first = await handleGenerateDesignVideo({ mode: 't2v', prompt: 'x', model: 'wan2.7-t2v', outputPath: out1, commandId });
    await fsp.rm(first.path, { force: true });
    const out2 = outPath('mp4');
    const second = await handleGenerateDesignVideo({ mode: 't2v', prompt: 'x', model: 'wan2.7-t2v', outputPath: out2, commandId });
    expect(generateVideoMock).toHaveBeenCalledTimes(2);
    expect(second.path).toBe(out2);
    await fsp.rm(path.dirname(path.dirname(out1)), { recursive: true, force: true });
  });
});

describe('handleGenerateDesignImage commandId 幂等（对称应用）', () => {
  it('同 commandId 重放 → 只调一次付费 service', async () => {
    const commandId = `gencmd-img-${Date.now()}`;
    const out1 = outPath('png');
    const first = await handleGenerateDesignImage({ prompt: '一朵花', outputPath: out1, commandId });
    const second = await handleGenerateDesignImage({ prompt: '一朵花', outputPath: outPath('png'), commandId });
    expect(generateImageMock).toHaveBeenCalledTimes(1);
    expect(second.path).toBe(first.path);
    await fsp.rm(path.dirname(path.dirname(out1)), { recursive: true, force: true });
  });
});

describe('handleGenerateDesignMusic commandId 幂等（对称应用）', () => {
  it('同 commandId 重放 → 只调一次付费 service', async () => {
    const commandId = `gencmd-music-${Date.now()}`;
    const out1 = outPath('mp3');
    const first = await handleGenerateDesignMusic({ prompt: '轻快钢琴', outputPath: out1, model: 'minimax-music-2.6', commandId });
    const second = await handleGenerateDesignMusic({ prompt: '轻快钢琴', outputPath: outPath('mp3'), model: 'minimax-music-2.6', commandId });
    expect(generateMusicMock).toHaveBeenCalledTimes(1);
    expect(second.path).toBe(first.path);
    await fsp.rm(path.dirname(path.dirname(out1)), { recursive: true, force: true });
  });
});

describe('handleGenerateSlidesDeck commandId 幂等（付费配图收口）', () => {
  it('同 commandId 重放 → 配图/排版只跑一次，第二次返回缓存 filePath', async () => {
    const commandId = `gencmd-deck-${Date.now()}`;
    const savedPath = path.join(os.tmpdir(), `idem-deck-${Date.now()}.pptx`);
    saveMock.mockImplementation(async ({ fileName }: { fileName: string; base64: string }) => {
      await fsp.writeFile(savedPath, `PPTX:${fileName}`);
      return { filePath: savedPath };
    });
    deckGenMock.mockResolvedValue({ buffer: Buffer.from('PPTX'), slidesCount: 3 });
    illustrateMock.mockResolvedValue({ images: [], costCny: 0.42 });
    const slides = [{ title: 'p1' }, { title: 'p2' }, { title: 'p3' }];

    const first = await handleGenerateSlidesDeck({ slides: slides as never, illustrate: true, imageModel: 'wanx2.1-t2i-plus', outputName: 'a.pptx', commandId });
    const second = await handleGenerateSlidesDeck({ slides: slides as never, illustrate: true, imageModel: 'wanx2.1-t2i-plus', outputName: 'a.pptx', commandId });
    expect(illustrateMock).toHaveBeenCalledTimes(1);
    expect(deckGenMock).toHaveBeenCalledTimes(1);
    expect(second.filePath).toBe(first.filePath);
    expect(second.costCny).toBe(first.costCny);
    await fsp.rm(savedPath, { force: true });
  });
});
