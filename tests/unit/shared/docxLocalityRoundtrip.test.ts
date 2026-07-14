import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';

vi.mock('../../../src/host/ipc/adminGuard', () => ({
  isCurrentUserAdmin: () => true,
  getAdminAccessIpcError: () => null,
  assertAdminAccess: vi.fn(),
}));

import { registerSettingsHandlers } from '../../../src/host/ipc/settings.ipc';
import {
  readDocxParagraphs,
  resolveDocxParagraphTarget,
} from '../../../src/host/tools/artifacts/docxParagraphLocator';
import {
  getArtifactLocatorPreflightBlock,
  upgradeLegacyAnchor,
} from '../../../src/host/tools/artifacts/artifactLocatorHost';
import { executeDocxEdit } from '../../../src/host/tools/modules/document/docxEditCore';
import type { Message } from '../../../src/shared/contract';
import type { ArtifactLocatorV1 } from '../../../src/shared/contract/artifactLocator';

type RawHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

const DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>复杂文档标题</w:t></w:r></w:p>
    <w:p><w:r><w:t>跨两个</w:t></w:r><w:r><w:t>文本 run</w:t></w:r></w:p>
    <w:p></w:p>
    <w:p><w:r><w:t>空段之后正文 sentinel</w:t></w:r></w:p>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格内目标 sentinel</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>列表项 sentinel</w:t></w:r></w:p>
    <w:p><w:r><w:t>重复文本 sentinel</w:t></w:r></w:p>
    <w:p><w:r><w:t>重复文本 sentinel</w:t></w:r></w:p>
    <w:p><w:r><w:t>表格外尾段 sentinel</w:t></w:r></w:p>
    <w:sectPr/>
  </w:body>
</w:document>`;

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

let workDir: string;
let handlers: Map<string, RawHandler>;

async function writeComplexDocx(filePath: string, documentXml = DOCUMENT_XML): Promise<void> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.file('_rels/.rels', ROOT_RELS);
  zip.file('word/document.xml', documentXml);
  await writeFile(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
}

function userTurn(locator: ArtifactLocatorV1): Message[] {
  return [{
    id: 'u1',
    role: 'user',
    content: '修改选中段落',
    timestamp: 1,
    metadata: { artifactLocator: locator },
  }] as Message[];
}

function docEditCall(filePath: string, index: number) {
  return {
    name: 'DocEdit',
    arguments: {
      file_path: filePath,
      operations: [{ action: 'replace_paragraph', index, text: '表格内目标已修改' }],
    },
  };
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'locator-word-'));
  handlers = new Map<string, RawHandler>();
  registerSettingsHandlers(
    { handle: (channel: string, handler: RawHandler) => handlers.set(channel, handler) } as never,
    () => ({}) as never,
  );
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('locator-word-complex.docx：读侧与真实 writer 对账', () => {
  it('保留真实 index 间隙、聚合跨 run 文本，并识别 heading/list/表格段落', async () => {
    const filePath = join(workDir, 'locator-word-complex.docx');
    await writeComplexDocx(filePath);
    const handler = handlers.get('extract-docx-html');
    expect(handler).toBeDefined();

    const result = await handler!(null, filePath) as {
      paragraphs: Array<{ index: number; type: string; text: string; level?: number }>;
    };

    expect(result.paragraphs.map((paragraph) => paragraph.index)).toEqual([0, 1, 3, 4, 5, 6, 7, 8]);
    expect(result.paragraphs[0]).toMatchObject({ index: 0, type: 'heading', level: 1 });
    expect(result.paragraphs[1]).toMatchObject({ index: 1, text: '跨两个文本 run' });
    expect(result.paragraphs.find((paragraph) => paragraph.index === 4)?.text).toBe('表格内目标 sentinel');
    expect(result.paragraphs.find((paragraph) => paragraph.index === 5)?.type).toBe('list-item');
  });

  it('resolver 输出 writer 同一 index，真实 executeDocxEdit 只改表格内目标', async () => {
    const filePath = join(workDir, 'locator-word-complex.docx');
    await writeComplexDocx(filePath);

    const resolved = await resolveDocxParagraphTarget(filePath, 4);
    expect(resolved?.target.paragraphIndex).toBe(4);
    expect(resolved?.paragraph.text).toBe('表格内目标 sentinel');

    const locator = await upgradeLegacyAnchor({
      kind: 'docx',
      filePath,
      paragraphIndex: 4,
      text: '表格内目标 sentinel',
      paragraphType: 'paragraph',
      displayName: 'locator-word-complex.docx',
    });
    expect(locator?.target).toMatchObject({ kind: 'docx-paragraph', paragraphIndex: 4 });

    const preflight = await getArtifactLocatorPreflightBlock(
      { messages: userTurn(locator!), workingDirectory: workDir },
      docEditCall(filePath, 4),
    );
    expect(preflight).toBeNull();

    const result = await executeDocxEdit({
      file_path: filePath,
      operations: [{ action: 'replace_paragraph', index: 4, text: '表格内目标已修改' }],
    });
    expect(result.success).toBe(true);

    const after = await readDocxParagraphs(filePath);
    expect(after.find((paragraph) => paragraph.index === 4)?.text).toBe('表格内目标已修改');
    expect(after.find((paragraph) => paragraph.index === 3)?.text).toBe('空段之后正文 sentinel');
    expect(after.filter((paragraph) => paragraph.text === '重复文本 sentinel')).toHaveLength(2);
    expect(after.find((paragraph) => paragraph.index === 8)?.text).toBe('表格外尾段 sentinel');
  });

  it('revision 或当前/邻居指纹漂移时，写工具调用次数都是 0', async () => {
    const filePath = join(workDir, 'locator-word-complex.docx');
    await writeComplexDocx(filePath);
    const locator = await upgradeLegacyAnchor({
      kind: 'docx',
      filePath,
      paragraphIndex: 4,
      text: '表格内目标 sentinel',
      paragraphType: 'paragraph',
    });
    expect(locator).not.toBeNull();

    const executeMock = vi.fn(executeDocxEdit);
    const guardedExecute = async (candidate: ArtifactLocatorV1) => {
      const call = docEditCall(filePath, 4);
      const block = await getArtifactLocatorPreflightBlock(
        { messages: userTurn(candidate), workingDirectory: workDir },
        call,
      );
      if (!block) await executeMock(call.arguments as never);
      return block;
    };

    const fingerprintDrift = structuredClone(locator!);
    if (fingerprintDrift.target.kind !== 'docx-paragraph') throw new Error('expected docx locator');
    fingerprintDrift.target.previousTextFingerprint = '0'.repeat(64);
    const fingerprintBlock = await guardedExecute(fingerprintDrift);
    expect(fingerprintBlock?.metadata.reason).toBe('paragraph_fingerprint_drift');
    expect(executeMock).toHaveBeenCalledTimes(0);

    await writeComplexDocx(filePath, DOCUMENT_XML.replace('空段之后正文 sentinel', '外部程序插入了新内容'));
    const revisionBlock = await guardedExecute(locator!);
    expect(revisionBlock?.metadata.reason).toBe('revision_drift');
    expect(executeMock).toHaveBeenCalledTimes(0);
  });
});
