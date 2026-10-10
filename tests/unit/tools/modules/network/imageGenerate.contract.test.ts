import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolContext, CanUseToolFn, Logger } from '../../../../../src/host/protocol/tools';
import { collectToolArtifactsFromMetadata } from '../../../../../src/shared/contract/artifactBlob';

const service = vi.hoisted(() => ({
  determineImageEngine: vi.fn(() => 'cogview' as const),
  generateImage: vi.fn(),
  generateImageFromReference: vi.fn(),
  downloadImageAsBase64: vi.fn(),
  isImageUrl: vi.fn((data: string) => data.startsWith('http')),
}));

const auth = vi.hoisted(() => ({ getCurrentUser: vi.fn(() => ({ isAdmin: false })) }));
const config = vi.hoisted(() => ({ getApiKey: vi.fn(), onSettingsUpdated: vi.fn() }));

vi.mock('../../../../../src/host/services/media/imageGenerationService', () => service);
vi.mock('../../../../../src/host/services/auth/authService', () => ({
  getAuthService: () => auth,
}));
vi.mock('../../../../../src/host/services', () => ({
  getConfigService: () => config,
}));
vi.mock('../../../../../src/host/utils/safeShell', () => ({
  safeExecDetached: vi.fn(),
}));

import { executeImageGenerate } from '../../../../../src/host/plugins/builtin/imageCreation/imageGenerate';
import { imageGenerateSchema } from '../../../../../src/host/plugins/builtin/imageCreation/imageGenerate.schema';

const IMAGE_DATA = 'data:image/png;base64,aW1hZ2U=';

function logger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function ctx(workspace: string, controller = new AbortController(), emit = vi.fn()): ToolContext {
  return {
    sessionId: 'contract-test',
    workingDir: workspace,
    abortSignal: controller.signal,
    logger: logger(),
    emit,
  } as unknown as ToolContext;
}

const allow: CanUseToolFn = async () => ({ allow: true });

describe('image_generate contract', () => {
  let workspace: string;
  let writeSpy: ReturnType<typeof vi.spyOn>;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'image-generate-contract-'));
    service.determineImageEngine.mockReturnValue('cogview');
    service.generateImage.mockReset();
    service.generateImageFromReference.mockReset();
    service.downloadImageAsBase64.mockReset();
    service.generateImage.mockResolvedValue({ imageData: IMAGE_DATA, actualModel: 'mock-model' });
    service.generateImageFromReference.mockResolvedValue({ imageData: IMAGE_DATA, actualModel: 'mock-reference-model' });
    writeSpy = vi.spyOn(fs, 'writeFileSync');
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    writeSpy.mockRestore();
    fetchSpy.mockRestore();
    fs.rmSync(workspace, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('exposes the batch schema without a union type', () => {
    const prompt = imageGenerateSchema.inputSchema.properties?.prompt;
    expect(prompt).toMatchObject({ type: 'array', items: { type: 'string' } });
    expect(imageGenerateSchema.inputSchema.properties?.reference_images)
      .toMatchObject({ type: 'array', items: { type: 'string' } });
    expect(imageGenerateSchema.inputSchema.properties?.output_file_path?.type).toBe('string');
    expect(imageGenerateSchema.inputSchema.properties?.output_path).toBeUndefined();
  });

  it.each([
    { args: { prompt: [] }, match: /at least one/ },
    { args: { prompt: Array.from({ length: 11 }, () => 'x') }, match: /more than 10/ },
    { args: { prompt: ['ok', 3] }, match: /non-empty strings/ },
    { args: { prompt: ['ok'], reference_images: ['a.png', 'b.png', 'c.png', 'd.png', 'e.png'] }, match: /more than 4/ },
    { args: { prompt: ['ok'], output_path: 'old.png' }, match: /renamed to output_file_path/ },
    { args: { prompt: ['ok'], output_file_path: '../outside.png' }, match: /inside the workspace/ },
  ])('refuses invalid args before any service, fetch, write, or briefing call', async ({ args, match }) => {
    const emit = vi.fn();
    const result = await executeImageGenerate(args, ctx(workspace, new AbortController(), emit), allow);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
      expect(result.error).toMatch(match);
    }
    expect(service.determineImageEngine).not.toHaveBeenCalled();
    expect(service.generateImage).not.toHaveBeenCalled();
    expect(service.generateImageFromReference).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('refuses outside, missing, non-image, and oversized references before generation', async () => {
    const missing = path.join(workspace, 'missing.png');
    const textFile = path.join(workspace, 'notes.txt');
    const oversized = path.join(workspace, 'large.png');
    fs.writeFileSync(textFile, 'text');
    fs.writeFileSync(oversized, Buffer.alloc(10 * 1024 * 1024 + 1));
    for (const reference of ['/tmp/outside.png', missing, textFile, oversized]) {
      const result = await executeImageGenerate(
        { prompt: ['ok'], reference_images: [reference] },
        ctx(workspace),
        allow,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    }
    expect(service.generateImage).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('saves independently with a concurrency-3 pool and records all artifacts', async () => {
    service.generateImage.mockImplementation(async (_engine, _model, prompt: string) => {
      if (prompt === 'fail') throw new Error('mock failure');
      return { imageData: IMAGE_DATA, actualModel: 'mock-model' };
    });
    const result = await executeImageGenerate(
      {
        prompt: ['one', 'fail', 'three'],
        output_file_path: 'images/result.png',
      },
      ctx(workspace),
      allow,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output).toMatch(/^2\/3 saved\nper_request /);
    expect(result.output).not.toContain('https://');
    const perRequest = result.meta?.per_request as Array<Record<string, unknown>>;
    expect(perRequest).toEqual([
      { index: 1, status: 'saved', bytes: 5, path: 'images/result-1.png' },
      { index: 2, status: 'failed', error: 'fail: mock failure' },
      { index: 3, status: 'saved', bytes: 5, path: 'images/result-3.png' },
    ]);
    expect(collectToolArtifactsFromMetadata(result.meta)).toHaveLength(2);
    expect(fs.existsSync(path.join(workspace, 'images/result-1.png'))).toBe(true);
    expect(fs.existsSync(path.join(workspace, 'images/result-3.png'))).toBe(true);
  });

  it('collects all three saved artifacts and keeps the legacy single-image fields', async () => {
    const batch = await executeImageGenerate({ prompt: ['a', 'b', 'c'] }, ctx(workspace), allow);
    expect(batch.ok).toBe(true);
    if (!batch.ok) return;
    expect(collectToolArtifactsFromMetadata(batch.meta)).toHaveLength(3);
    expect((batch.meta?.per_request as Array<{ path?: string }>).map((item) => item.path))
      .toEqual(expect.arrayContaining([
        expect.stringMatching(/^\.code-agent\/artifacts\/images\/generated-.*-1\.png$/),
        expect.stringMatching(/^\.code-agent\/artifacts\/images\/generated-.*-2\.png$/),
        expect.stringMatching(/^\.code-agent\/artifacts\/images\/generated-.*-3\.png$/),
      ]));

    const single = await executeImageGenerate({ prompt: ['single'] }, ctx(workspace), allow);
    expect(single.ok).toBe(true);
    if (!single.ok) return;
    expect(single.meta).toMatchObject({
      artifact: expect.objectContaining({ kind: 'image', sourceTool: 'image_generate' }),
      imagePath: expect.any(String),
      outputPath: expect.any(String),
      imageBase64: undefined,
      originalPrompt: 'single',
    });
  });

  it('reports all failures as ok:false and aborts unscheduled work', async () => {
    service.generateImage.mockRejectedValue(new Error('all failed'));
    const failed = await executeImageGenerate({ prompt: ['a', 'b'] }, ctx(workspace), allow);
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error).toMatch(/^0\/2 saved\nper_request /);

    const controller = new AbortController();
    service.generateImage.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { imageData: IMAGE_DATA, actualModel: 'mock-model' };
    });
    const pending = executeImageGenerate(
      { prompt: ['a', 'b', 'c', 'd', 'e'] },
      ctx(workspace, controller),
      allow,
    );
    setTimeout(() => controller.abort(), 2);
    const aborted = await pending;
    const abortedText = aborted.ok ? aborted.output : aborted.error;
    expect(abortedText).toContain('5 saved');
    expect(abortedText).toContain('\"error\":\"aborted\"');
  });

  it('uses only the first reference and reports the reference count', async () => {
    fs.writeFileSync(path.join(workspace, 'ref.png'), 'reference');
    fs.writeFileSync(path.join(workspace, 'ref.webp'), 'reference');
    const result = await executeImageGenerate(
      { prompt: ['reference result'], reference_images: ['ref.png', 'ref.webp'] },
      ctx(workspace),
      allow,
    );
    expect(result.ok).toBe(true);
    expect(service.generateImageFromReference).toHaveBeenCalledTimes(1);
    expect(service.generateImage).not.toHaveBeenCalled();
    if (result.ok) expect(result.output).toContain('references used: 1 of 2');
  });
});
