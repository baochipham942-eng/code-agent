import { File as NodeFile } from 'node:buffer';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleInspectPresentation } from '../../../src/host/ipc/workspaceArchive.ipc';
import {
  computeArtifactRevision,
  getArtifactLocatorPreflightBlock,
} from '../../../src/host/tools/artifacts/artifactLocatorHost';
import { resolvePresentationPackageIndex } from '../../../src/host/tools/artifacts/presentationPackageIndex';
import { executePptEdit } from '../../../src/host/tools/modules/network/pptEdit';
import { buildPresentationSummary } from '../../../src/renderer/components/features/chat/ChatInput/attachmentSummaries';
import type { ArtifactLocatorV1, Message } from '../../../src/shared/contract';
import { slideIndexFromPartName } from '../../../src/shared/contract/artifactLocator';
import type { CanUseToolFn, Logger, ToolContext } from '../../../src/host/protocol/tools';

const PRESENTATION_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

const SLIDE_XML = (partNumber: number) => `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree>
    <a:t>Title ${partNumber}</a:t>
    <a:t>SENTINEL_SLIDE_${partNumber}</a:t>
  </p:spTree></p:cSld>
</p:sld>`;

const PRESENTATION_XML = `<?xml version="1.0" encoding="UTF-8"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
                xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldIdLst>
    <p:sldId id="701" r:id="rId73"/>
    <p:sldId id="702" r:id="rId9"/>
    <p:sldId id="703" r:id="rId101"/>
  </p:sldIdLst>
</p:presentation>`;

const RELATIONSHIPS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId9" Type="slide" Target="slides/slide2.xml"/>
  <Relationship Id="rId101" Type="slide" Target="slides/slide11.xml"/>
  <Relationship Id="rId73" Type="slide" Target="slides/slide7.xml"/>
</Relationships>`;

async function buildReorderedGappedPptx(filePath: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('ppt/presentation.xml', PRESENTATION_XML);
  zip.file('ppt/_rels/presentation.xml.rels', RELATIONSHIPS_XML);
  for (const partNumber of [2, 7, 11]) {
    zip.file(`ppt/slides/slide${partNumber}.xml`, SLIDE_XML(partNumber));
  }
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  await writeFile(filePath, buffer);
  return buffer;
}

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(workDir: string): ToolContext {
  return {
    sessionId: 'presentation-package-index-test',
    workingDir: workDir,
    abortSignal: new AbortController().signal,
    logger: makeLogger(),
    emit: () => void 0,
  } as unknown as ToolContext;
}

const allowAll: CanUseToolFn = async () => ({ allow: true });

function userTurn(locator: ArtifactLocatorV1): Message[] {
  return [{
    id: 'u-ppt-locator',
    role: 'user',
    content: '修改显示第 2 页',
    timestamp: 1,
    metadata: { artifactLocator: locator },
  }] as Message[];
}

async function locatorForDisplayIndex(filePath: string, displayIndex: number): Promise<ArtifactLocatorV1> {
  const targets = await resolvePresentationPackageIndex(filePath);
  return {
    version: 1,
    artifact: {
      kind: 'presentation',
      filePath,
      revision: await computeArtifactRevision(filePath),
    },
    target: { kind: 'ppt-slide', ...targets[displayIndex] },
    display: { label: `第 ${displayIndex + 1} 页`, excerpt: `Title ${targets[displayIndex].slidePartName}` },
  };
}

async function replacePresentationXml(filePath: string, nextXml: string): Promise<void> {
  const zip = await JSZip.loadAsync(await readFile(filePath));
  zip.file('ppt/presentation.xml', nextXml);
  await writeFile(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
}

let workDir: string;
let pptxPath: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'locator-ppt-reordered-gapped-'));
  pptxPath = join(workDir, 'locator-ppt-reordered-gapped.pptx');
  await buildReorderedGappedPptx(pptxPath);
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('ADR-040 C1：reordered + gapped presentation package index', () => {
  it('resolver、Workspace preview、上传摘要都以 sldIdLst 的 7→2→11 为显示顺序', async () => {
    const index = await resolvePresentationPackageIndex(pptxPath);
    expect(index.map(({ displayIndex, relationshipId, slidePartName }) => ({
      displayIndex,
      relationshipId,
      slidePartName,
    }))).toEqual([
      { displayIndex: 0, relationshipId: 'rId73', slidePartName: 'ppt/slides/slide7.xml' },
      { displayIndex: 1, relationshipId: 'rId9', slidePartName: 'ppt/slides/slide2.xml' },
      { displayIndex: 2, relationshipId: 'rId101', slidePartName: 'ppt/slides/slide11.xml' },
    ]);
    expect(index.map((target) => target.textFingerprint)).toEqual([
      expect.stringMatching(/^[0-9a-f]{16}$/),
      expect.stringMatching(/^[0-9a-f]{16}$/),
      expect.stringMatching(/^[0-9a-f]{16}$/),
    ]);

    const workspacePreview = await handleInspectPresentation({ filePath: pptxPath, limit: 10 });
    expect(workspacePreview.slides.map((slide) => slide.title)).toEqual(['Title 7', 'Title 2', 'Title 11']);
    expect(workspacePreview.slides.map((slide) => slide.index)).toEqual([1, 2, 3]);

    const uploadFile = new NodeFile([await readFile(pptxPath)], 'locator-ppt-reordered-gapped.pptx', {
      type: PRESENTATION_MIME,
    });
    const uploadSummary = await buildPresentationSummary(uploadFile as unknown as File);
    expect(uploadSummary.slides?.map((slide) => slide.title)).toEqual(['Title 7', 'Title 2', 'Title 11']);
    expect(uploadSummary.slides?.map((slide) => slide.index)).toEqual([1, 2, 3]);
  });

  it('选择显示第 2 页只改 slide2.xml，slide7.xml / slide11.xml 的 sentinel 不动', async () => {
    const locator = await locatorForDisplayIndex(pptxPath, 1);
    if (locator.target.kind !== 'ppt-slide') throw new Error('expected ppt-slide locator');
    const slideIndex = slideIndexFromPartName(locator.target.slidePartName);
    expect(slideIndex).toBe(1);

    const toolMock = vi.fn((args: Record<string, unknown>) => executePptEdit(args, makeCtx(workDir), allowAll));
    const args = {
      file_path: pptxPath,
      action: 'replace_title',
      slide_index: slideIndex,
      title: 'Selected Display Page 2',
    };
    const block = await getArtifactLocatorPreflightBlock(
      { messages: userTurn(locator), workingDirectory: workDir },
      { name: 'ppt_edit', arguments: args },
    );
    if (!block) await toolMock(args);
    expect(block).toBeNull();
    expect(toolMock).toHaveBeenCalledTimes(1);

    const edited = await JSZip.loadAsync(await readFile(pptxPath));
    const slide2 = await edited.file('ppt/slides/slide2.xml')!.async('string');
    const slide7 = await edited.file('ppt/slides/slide7.xml')!.async('string');
    const slide11 = await edited.file('ppt/slides/slide11.xml')!.async('string');
    expect(slide2).toContain('Selected Display Page 2');
    expect(slide2).toContain('SENTINEL_SLIDE_2');
    expect(slide7).toBe(SLIDE_XML(7));
    expect(slide11).toBe(SLIDE_XML(11));
  });

  it('relationship 漂移后 fail-closed，工具调用次数为 0', async () => {
    const locator = await locatorForDisplayIndex(pptxPath, 1);
    await replacePresentationXml(pptxPath, PRESENTATION_XML.replace('r:id="rId9"', 'r:id="rId88"'));
    const zip = await JSZip.loadAsync(await readFile(pptxPath));
    zip.file(
      'ppt/_rels/presentation.xml.rels',
      RELATIONSHIPS_XML.replace('</Relationships>', '<Relationship Id="rId88" Type="slide" Target="slides/slide2.xml"/></Relationships>'),
    );
    await writeFile(pptxPath, await zip.generateAsync({ type: 'nodebuffer' }));
    locator.artifact.revision = await computeArtifactRevision(pptxPath);

    const toolMock = vi.fn();
    const block = await getArtifactLocatorPreflightBlock(
      { messages: userTurn(locator), workingDirectory: workDir },
      { name: 'ppt_edit', arguments: { file_path: pptxPath, action: 'replace_title', slide_index: 1, title: 'x' } },
    );
    if (!block) await toolMock();
    expect(block?.metadata.reason).toBe('relationship_drift');
    expect(toolMock).toHaveBeenCalledTimes(0);
  });

  it('revision 漂移后 fail-closed，工具调用次数为 0', async () => {
    const locator = await locatorForDisplayIndex(pptxPath, 1);
    const zip = await JSZip.loadAsync(await readFile(pptxPath));
    zip.file('ppt/slides/slide2.xml', SLIDE_XML(2).replace('SENTINEL_SLIDE_2', 'EXTERNAL_REVISION_DRIFT'));
    await writeFile(pptxPath, await zip.generateAsync({ type: 'nodebuffer' }));

    const toolMock = vi.fn();
    const block = await getArtifactLocatorPreflightBlock(
      { messages: userTurn(locator), workingDirectory: workDir },
      { name: 'ppt_edit', arguments: { file_path: pptxPath, action: 'replace_title', slide_index: 1, title: 'x' } },
    );
    if (!block) await toolMock();
    expect(block?.metadata.reason).toBe('revision_drift');
    expect(toolMock).toHaveBeenCalledTimes(0);
  });
});
