import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
});
