import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Request, Response } from 'express';

vi.mock('../../../src/host/platform/appPaths', () => ({
  getUserDataPath: () => '/fake/userdata',
}));

vi.mock('../../../src/host/services/infra/browser/managedBrowserHelpers', () => ({
  MANAGED_BROWSER_ARTIFACT_DIR: 'screenshots',
}));

vi.mock('../../../src/host/services/desktop/nativeDesktopService', () => ({
  resolveNativeDesktopCandidateRoots: () => ['/fake/userdata', '/fake/home/.code-agent'],
}));

import { handleScreenshot } from '../../../src/web/helpers/upload';

function mockReq(path: string): Request {
  return { query: { path } } as unknown as Request;
}

function mockRes() {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    status(code: number) { this.statusCode = code; return this; },
    json() { return this; },
    setHeader(key: string, value: string) { this.headers[key] = value; },
  };
  return res as unknown as Response & typeof res;
}

describe('handleScreenshot whitelist', () => {
  afterEach(() => vi.restoreAllMocks());

  it('serves browser screenshots from the runtime userData/screenshots dir', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const pipe = vi.fn();
    vi.spyOn(fs, 'createReadStream').mockReturnValue({ pipe } as unknown as fs.ReadStream);

    const res = mockRes();
    handleScreenshot(mockReq('/fake/userdata/screenshots/screenshot_123.png'), res);

    expect(res.statusCode).toBe(0); // never set to 403/404
    expect(res.headers['Content-Type']).toBe('image/png');
    expect(pipe).toHaveBeenCalledOnce();
  });

  it('serves appshots from the runtime userData/appshots dir', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const pipe = vi.fn();
    vi.spyOn(fs, 'createReadStream').mockReturnValue({ pipe } as unknown as fs.ReadStream);

    const res = mockRes();
    handleScreenshot(mockReq('/fake/userdata/appshots/a.png'), res);

    expect(res.statusCode).toBe(0);
    expect(pipe).toHaveBeenCalledOnce();
  });

  it('serves native-desktop screenshots from a candidate root', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const pipe = vi.fn();
    vi.spyOn(fs, 'createReadStream').mockReturnValue({ pipe } as unknown as fs.ReadStream);

    const res = mockRes();
    handleScreenshot(mockReq('/fake/home/.code-agent/native-desktop/screenshots/a.png'), res);

    expect(res.statusCode).toBe(0);
    expect(pipe).toHaveBeenCalledOnce();
  });

  it('serves native-desktop screenshots using backslash separators (Windows-style subpath)', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const pipe = vi.fn();
    vi.spyOn(fs, 'createReadStream').mockReturnValue({ pipe } as unknown as fs.ReadStream);

    const res = mockRes();
    handleScreenshot(mockReq('/fake/userdata/native-desktop\\screenshots\\a.png'), res);

    expect(res.statusCode).toBe(0);
    expect(pipe).toHaveBeenCalledOnce();
  });

  it('serves pptx page previews from the runtime userData presentation cache dir', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const pipe = vi.fn();
    vi.spyOn(fs, 'createReadStream').mockReturnValue({ pipe } as unknown as fs.ReadStream);

    const res = mockRes();
    handleScreenshot(mockReq('/fake/userdata/cache/presentation-page-previews/rev123/pages/deck-01.jpg'), res);

    expect(res.statusCode).toBe(0);
    expect(res.headers['Content-Type']).toBe('image/jpeg');
    expect(pipe).toHaveBeenCalledOnce();
  });

  it('denies presentation cache lookalike dirs outside the runtime userData root', () => {
    const res = mockRes();
    handleScreenshot(mockReq('/tmp/evil/cache/presentation-page-previews/rev123/pages/deck-01.jpg'), res);

    expect(res.statusCode).toBe(403);
  });

  it('serves agent work-dir images from the runtime userData/work dir（产物裂图 C.12）', () => {
    // ~/.code-agent(-dev)/work/ 下的真实图片此前被 403（不在白名单）→ 灰底问号裂图
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const pipe = vi.fn();
    vi.spyOn(fs, 'createReadStream').mockReturnValue({ pipe } as unknown as fs.ReadStream);

    const res = mockRes();
    handleScreenshot(mockReq('/fake/userdata/work/session-1/pricing-chart.png'), res);

    expect(res.statusCode).toBe(0);
    expect(res.headers['Content-Type']).toBe('image/png');
    expect(pipe).toHaveBeenCalledOnce();
  });

  it('denies traversal that escapes the work dir', () => {
    const res = mockRes();
    handleScreenshot(mockReq('/fake/userdata/work/../../etc/secret.png'), res);

    expect(res.statusCode).toBe(403);
  });

  it('serves images only from a persisted session working directory artifact subtree', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-session-artifact-'));
    const artifactDir = path.join(root, '.code-agent', 'artifacts', 'images');
    fs.mkdirSync(artifactDir, { recursive: true });
    const imagePath = path.join(artifactDir, 'generated.png');
    fs.writeFileSync(imagePath, 'png');
    const pipe = vi.fn();
    vi.spyOn(fs, 'createReadStream').mockReturnValue({ pipe } as unknown as fs.ReadStream);

    const res = mockRes();
    handleScreenshot(mockReq(imagePath), res, { sessionWorkingDirectories: [root] });

    expect(res.statusCode).toBe(0);
    expect(res.headers['Content-Type']).toBe('image/png');
    expect(pipe).toHaveBeenCalledOnce();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('denies traversal and symlink escape from a bound session artifact subtree', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-session-artifact-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-session-outside-'));
    const artifactDir = path.join(root, '.code-agent', 'artifacts');
    fs.mkdirSync(artifactDir, { recursive: true });
    const outsideImage = path.join(outside, 'secret.png');
    fs.writeFileSync(outsideImage, 'png');
    const symlinkPath = path.join(artifactDir, 'escaped.png');
    fs.symlinkSync(outsideImage, symlinkPath);

    const traversalRes = mockRes();
    handleScreenshot(
      mockReq(path.join(artifactDir, '..', '..', '..', path.basename(outside), 'secret.png')),
      traversalRes,
      { sessionWorkingDirectories: [root] },
    );
    expect(traversalRes.statusCode).toBe(403);

    const symlinkRes = mockRes();
    handleScreenshot(mockReq(symlinkPath), symlinkRes, { sessionWorkingDirectories: [root] });
    expect(symlinkRes.statusCode).toBe(403);

    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('denies non-image files inside the work dir', () => {
    const res = mockRes();
    handleScreenshot(mockReq('/fake/userdata/work/session-1/notes.md'), res);

    expect(res.statusCode).toBe(403);
  });

  it('denies paths outside any allowed screenshot dir', () => {
    const res = mockRes();
    handleScreenshot(mockReq('/etc/passwd.png'), res);

    expect(res.statusCode).toBe(403);
  });

  it('denies native-desktop lookalike dirs outside candidate roots', () => {
    const res = mockRes();
    handleScreenshot(mockReq('/tmp/x/native-desktop/screenshots/a.png'), res);

    expect(res.statusCode).toBe(403);
  });

  it('denies config-dir lookalike paths outside candidate roots', () => {
    const res = mockRes();
    handleScreenshot(mockReq('/tmp/evil/.code-agent/native-desktop/screenshots/a.png'), res);

    expect(res.statusCode).toBe(403);
  });

  it('denies traversal that escapes the screenshots dir', () => {
    const res = mockRes();
    handleScreenshot(mockReq('/fake/userdata/screenshots/../../etc/secret.png'), res);

    expect(res.statusCode).toBe(403);
  });
});
