import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { handlePreviewPresentation } from '../../../src/host/ipc/workspaceArchive.ipc';

async function writeReorderedDeck(filePath: string): Promise<void> {
  const zip = new JSZip();
  zip.file('ppt/presentation.xml', [
    '<p:presentation xmlns:p="p" xmlns:r="r">',
    '<p:sldIdLst><p:sldId id="1" r:id="rId7"/><p:sldId id="2" r:id="rId2"/></p:sldIdLst>',
    '</p:presentation>',
  ].join(''));
  zip.file('ppt/_rels/presentation.xml.rels', [
    '<Relationships>',
    '<Relationship Id="rId7" Target="slides/slide7.xml"/>',
    '<Relationship Id="rId2" Target="slides/slide2.xml"/>',
    '</Relationships>',
  ].join(''));
  zip.file('ppt/slides/slide7.xml', '<p:sld><a:t>蓝色封面</a:t></p:sld>');
  zip.file('ppt/slides/slide2.xml', '<p:sld><a:t>经营数据</a:t></p:sld>');
  await writeFile(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
}

describe('上传 PPT 逐页截图缓存 IPC', () => {
  let workDir: string;
  let deckPath: string;
  let cacheRoot: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'presentation-page-preview-'));
    deckPath = join(workDir, 'deck.pptx');
    cacheRoot = join(workDir, 'cache');
    await writeReorderedDeck(deckPath);
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('LibreOffice 可用：一次转换全部页，截图按 resolver displayIndex 绑定 locator，并命中 revision 缓存', async () => {
    const convert = vi.fn(async (_pptxPath: string, outputDir: string) => {
      await mkdir(outputDir, { recursive: true });
      const screenshots = [join(outputDir, 'deck-1.jpg'), join(outputDir, 'deck-2.jpg')];
      await Promise.all(screenshots.map((screenshot) => writeFile(screenshot, 'image')));
      return screenshots;
    });

    const first = await handlePreviewPresentation(
      { filePath: deckPath },
      { cacheRoot, libreOfficeAvailable: () => true, convert },
    );
    const second = await handlePreviewPresentation(
      { filePath: deckPath },
      { cacheRoot, libreOfficeAvailable: () => true, convert },
    );

    expect(first.state).toBe('ready');
    expect(first.pages).toHaveLength(2);
    expect(first.pages.map((page) => ({
      title: page.title,
      displayIndex: page.locator.target.displayIndex,
      relationshipId: page.locator.target.relationshipId,
      slidePartName: page.locator.target.slidePartName,
      screenshotPath: page.screenshotPath,
    }))).toEqual([
      {
        title: '蓝色封面',
        displayIndex: 0,
        relationshipId: 'rId7',
        slidePartName: 'ppt/slides/slide7.xml',
        screenshotPath: expect.stringContaining('deck-1.jpg'),
      },
      {
        title: '经营数据',
        displayIndex: 1,
        relationshipId: 'rId2',
        slidePartName: 'ppt/slides/slide2.xml',
        screenshotPath: expect.stringContaining('deck-2.jpg'),
      },
    ]);
    expect(second.pages.map((page) => page.locator)).toEqual(first.pages.map((page) => page.locator));
    expect(convert).toHaveBeenCalledTimes(1);
  });

  it('LibreOffice 缺席：不转换截图，但每页大纲仍携带可选 locator', async () => {
    const convert = vi.fn();
    const result = await handlePreviewPresentation(
      { filePath: deckPath },
      { cacheRoot, libreOfficeAvailable: () => false, convert },
    );

    expect(result.state).toBe('libreoffice-missing');
    expect(result.pages.map((page) => page.title)).toEqual(['蓝色封面', '经营数据']);
    expect(result.pages.map((page) => page.locator.target.slidePartName)).toEqual([
      'ppt/slides/slide7.xml',
      'ppt/slides/slide2.xml',
    ]);
    expect(result.pages.every((page) => page.screenshotPath === undefined)).toBe(true);
    expect(convert).not.toHaveBeenCalled();
  });

  it('转换失败：回退可选大纲，不把部分截图错绑给页面', async () => {
    const result = await handlePreviewPresentation(
      { filePath: deckPath },
      {
        cacheRoot,
        libreOfficeAvailable: () => true,
        convert: async () => { throw new Error('soffice crashed'); },
      },
    );

    expect(result.state).toBe('conversion-failed');
    expect(result.error).toContain('soffice crashed');
    expect(result.pages).toHaveLength(2);
    expect(result.pages.every((page) => page.screenshotPath === undefined)).toBe(true);
    expect(result.pages[1].locator.target.displayIndex).toBe(1);
  });

  it('缓存 miss 写入 filePath/lastUsedAt，命中回写刷新 lastUsedAt，convert 不重跑', async () => {
    const convert = vi.fn(async (_pptxPath: string, outputDir: string) => {
      await mkdir(outputDir, { recursive: true });
      const screenshots = [join(outputDir, 'deck-1.jpg'), join(outputDir, 'deck-2.jpg')];
      await Promise.all(screenshots.map((screenshot) => writeFile(screenshot, 'image')));
      return screenshots;
    });
    const dependencies = { cacheRoot, libreOfficeAvailable: () => true, convert };

    const revision = createHash('sha256').update(await readFile(deckPath)).digest('hex');
    await handlePreviewPresentation({ filePath: deckPath }, dependencies);
    const manifestPath = join(cacheRoot, revision, 'manifest.json');
    const first = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      revision: string;
      screenshots: string[];
      filePath?: string;
      lastUsedAt?: number;
    };
    expect(first.revision).toBe(revision);
    expect(first.screenshots).toHaveLength(2);
    expect(first.filePath).toBe(deckPath);
    expect(typeof first.lastUsedAt).toBe('number');

    await new Promise((resolve) => { setTimeout(resolve, 25); });
    const second = await handlePreviewPresentation({ filePath: deckPath }, dependencies);
    expect(second.state).toBe('ready');
    const refreshed = JSON.parse(await readFile(manifestPath, 'utf8')) as { lastUsedAt?: number };
    expect(typeof refreshed.lastUsedAt).toBe('number');
    expect(refreshed.lastUsedAt!).toBeGreaterThan(first.lastUsedAt!);
    expect(convert).toHaveBeenCalledTimes(1);
  });

  it('旧格式 manifest（无 filePath/lastUsedAt）照常命中，命中后补全两字段', async () => {
    const convert = vi.fn(async (_pptxPath: string, outputDir: string) => {
      await mkdir(outputDir, { recursive: true });
      const screenshots = [join(outputDir, 'deck-1.jpg'), join(outputDir, 'deck-2.jpg')];
      await Promise.all(screenshots.map((screenshot) => writeFile(screenshot, 'image')));
      return screenshots;
    });

    // 另一份内容不同的 deck（revision 不同，避免与旧 manifest 目录撞名）
    const legacyDeckPath = join(workDir, 'legacy-deck.pptx');
    const zip = new JSZip();
    zip.file('ppt/presentation.xml', '<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="1" r:id="rId7"/></p:sldIdLst></p:presentation>');
    zip.file('ppt/_rels/presentation.xml.rels', '<Relationships><Relationship Id="rId7" Target="slides/slide7.xml"/></Relationships>');
    zip.file('ppt/slides/slide7.xml', '<p:sld><a:t>旧清单单页</a:t></p:sld>');
    await writeFile(legacyDeckPath, await zip.generateAsync({ type: 'nodebuffer' }));

    const revision = createHash('sha256').update(await readFile(legacyDeckPath)).digest('hex');
    const legacyDir = join(cacheRoot, revision, 'pages');
    await mkdir(legacyDir, { recursive: true });
    const screenshots = [join(legacyDir, 'deck-1.jpg')];
    await writeFile(screenshots[0], 'image');
    await writeFile(
      join(cacheRoot, revision, 'manifest.json'),
      JSON.stringify({ revision, screenshots }),
    );

    const result = await handlePreviewPresentation(
      { filePath: legacyDeckPath },
      { cacheRoot, libreOfficeAvailable: () => true, convert },
    );

    expect(result.state).toBe('ready');
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].screenshotPath).toBe(screenshots[0]);
    expect(convert).not.toHaveBeenCalled();
    const upgraded = JSON.parse(await readFile(join(cacheRoot, revision, 'manifest.json'), 'utf8')) as {
      screenshots: string[];
      filePath?: string;
      lastUsedAt?: number;
    };
    expect(upgraded.screenshots).toEqual(screenshots);
    expect(upgraded.filePath).toBe(legacyDeckPath);
    expect(typeof upgraded.lastUsedAt).toBe('number');
  });
});
