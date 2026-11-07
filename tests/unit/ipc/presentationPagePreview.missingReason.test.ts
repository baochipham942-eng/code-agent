// libreoffice-missing 预览态的原因透传：真实 ensure/state 模块（仅注入网络探针），
// 不手搓 state。N-PY-RUNTIME-K3-PREVIEW-NOINSTALL。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { handlePreviewPresentation } from '../../../src/host/ipc/workspaceArchive.ipc';
import { ensureLibreOffice } from '../../../src/host/runtime/libreOffice/ensure';
import { getLibreOfficeState } from '../../../src/host/runtime/libreOffice/state';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

let dataDir: string;
let deck: string;

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lo-missing-reason-'));
  const zip = new JSZip();
  zip.file('ppt/presentation.xml', '<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="1" r:id="rId1"/></p:sldIdLst></p:presentation>');
  zip.file('ppt/_rels/presentation.xml.rels', '<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>');
  zip.file('ppt/slides/slide1.xml', '<p:sld><a:t>Hi</a:t></p:sld>');
  deck = path.join(dataDir, 'deck.pptx');
  fs.writeFileSync(deck, await zip.generateAsync({ type: 'nodebuffer' }));
});

afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

describe('libreoffice-missing 预览携带真实原因', () => {
  it('离线安装失败：真实 ensure 创建 runtimes/libreoffice 并落 install.log，预览带 OFFLINE 码', async () => {
    const result = await ensureLibreOffice({
      dataDir,
      platform: 'darwin',
      probe: async (url) => ({ url, ok: false, ttfbMs: 9999 }),
    });
    expect(result.ok).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'runtimes', 'libreoffice', 'install.log'))).toBe(true);

    const preview = await handlePreviewPresentation({ filePath: deck }, {
      cacheRoot: path.join(dataDir, 'cache'),
      libreOfficeAvailable: () => false,
      libreOfficeState: () => getLibreOfficeState({
        dataDir, platform: 'darwin', existsSync: (p) => p.startsWith(dataDir) && fs.existsSync(p), which: () => null,
      }),
    });
    expect(preview.state).toBe('libreoffice-missing');
    expect(preview.error).toBe('LIBREOFFICE_RUNTIME_OFFLINE');
  });

  it('非 darwin：预览带 UNSUPPORTED 码', async () => {
    const preview = await handlePreviewPresentation({ filePath: deck }, {
      cacheRoot: path.join(dataDir, 'cache'),
      libreOfficeAvailable: () => false,
      libreOfficeState: () => getLibreOfficeState({ dataDir, platform: 'linux' }),
    });
    expect(preview.error).toBe('LIBREOFFICE_RUNTIME_UNSUPPORTED');
  });

  it('尚未触发安装（missing）：不带码，沿用「正在准备」', async () => {
    const preview = await handlePreviewPresentation({ filePath: deck }, {
      cacheRoot: path.join(dataDir, 'cache'),
      libreOfficeAvailable: () => false,
      libreOfficeState: () => getLibreOfficeState({
        dataDir: path.join(dataDir, 'fresh'), platform: 'darwin', existsSync: () => false, which: () => null,
      }),
    });
    expect(preview.error).toBeUndefined();
  });

  it('zh/en 都有三条具体文案', () => {
    for (const d of [zh.design, en.design]) {
      expect(d.slidesPreviewOffline).toBeTruthy();
      expect(d.slidesPreviewInstallFailed).toBeTruthy();
      expect(d.slidesPreviewUnsupported).toBeTruthy();
    }
  });
});
