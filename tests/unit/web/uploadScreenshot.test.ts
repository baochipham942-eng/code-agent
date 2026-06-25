import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import type { Request, Response } from 'express';

vi.mock('../../../src/main/platform/appPaths', () => ({
  getUserDataPath: () => '/fake/userdata',
}));

vi.mock('../../../src/main/services/infra/browser/managedBrowserHelpers', () => ({
  MANAGED_BROWSER_ARTIFACT_DIR: 'screenshots',
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

  it('serves native-desktop screenshots using Windows backslash separators', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const pipe = vi.fn();
    vi.spyOn(fs, 'createReadStream').mockReturnValue({ pipe } as unknown as fs.ReadStream);

    const res = mockRes();
    handleScreenshot(mockReq('C:\\Users\\lin\\AppData\\code-agent\\native-desktop\\screenshots\\a.png'), res);

    expect(res.statusCode).toBe(0);
    expect(pipe).toHaveBeenCalledOnce();
  });

  it('denies paths outside any allowed screenshot dir', () => {
    const res = mockRes();
    handleScreenshot(mockReq('/etc/passwd.png'), res);

    expect(res.statusCode).toBe(403);
  });

  it('denies traversal that escapes the screenshots dir', () => {
    const res = mockRes();
    handleScreenshot(mockReq('/fake/userdata/screenshots/../../etc/secret.png'), res);

    expect(res.statusCode).toBe(403);
  });
});
